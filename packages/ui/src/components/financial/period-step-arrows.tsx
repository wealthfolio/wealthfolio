import { cn } from "../../lib/utils";
import { Icons } from "../ui/icons";

interface PeriodStepArrowsProps {
  onPrevious: () => void;
  onNext: () => void;
  previousDisabled?: boolean;
  nextDisabled?: boolean;
  previousLabel: string;
  nextLabel: string;
  className?: string;
}

/**
 * Small chevron pair for paging a selected time period backward/forward by
 * its own window size (e.g. 1Y steps a year at a time). Purely
 * presentational — callers own the offset state and step logic.
 *
 * `previousDisabled` is for periods with no meaningful "prior window" (e.g.
 * "All time") — pass it rather than hiding the arrows, so the control stays
 * visually consistent across periods.
 */
export function PeriodStepArrows({
  onPrevious,
  onNext,
  previousDisabled,
  nextDisabled,
  previousLabel,
  nextLabel,
  className,
}: PeriodStepArrowsProps) {
  return (
    <span className={cn("inline-flex items-center gap-0.5 normal-case", className)}>
      <button
        type="button"
        onClick={onPrevious}
        disabled={previousDisabled}
        className="hover:bg-muted hover:text-foreground disabled:text-muted-foreground/30 flex h-5 w-5 items-center justify-center rounded-full transition-colors disabled:cursor-not-allowed"
        aria-label={previousLabel}
      >
        <Icons.ChevronLeft className="h-3 w-3" />
      </button>
      <button
        type="button"
        onClick={onNext}
        disabled={nextDisabled}
        className="hover:bg-muted hover:text-foreground disabled:text-muted-foreground/30 flex h-5 w-5 items-center justify-center rounded-full transition-colors disabled:cursor-not-allowed"
        aria-label={nextLabel}
      >
        <Icons.ChevronRight className="h-3 w-3" />
      </button>
    </span>
  );
}
