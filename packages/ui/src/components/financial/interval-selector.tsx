import { AnimatedToggleGroup } from "../ui/animated-toggle-group";
import { useTranslation } from "react-i18next";
import { useIsMobile } from "../../hooks/use-mobile";
import { usePersistentState } from "../../hooks/use-persistent-state";
import { cn } from "../../lib/utils";
import { startOfYear, subDays, subMonths, subWeeks, subYears } from "date-fns";
import React, { useCallback, useState } from "react";

export type TimePeriod = "1D" | "1W" | "1M" | "3M" | "6M" | "YTD" | "1Y" | "5Y" | "ALL";
export interface DateRange {
  from: Date | undefined;
  to: Date | undefined;
}

interface IntervalData {
  code: TimePeriod;
  description: string;
  calculateRange: (anchor: Date) => DateRange | undefined;
}

const intervalDescriptions: Record<TimePeriod, string> = {
  "1D": "past day",
  "1W": "past week",
  "1M": "past month",
  "3M": "past 3 months",
  "6M": "past 6 months",
  YTD: "year to date",
  "1Y": "past year",
  "5Y": "past 5 years",
  ALL: "All Time",
};

/**
 * How far one "step" of the period-navigation arrows moves the anchor date
 * for each code, so paging a rolling window (e.g. 1Y) lands on the
 * equivalent prior window. `null` means the period can't be paged (ALL has
 * no meaningful "prior window").
 */
export const PERIOD_STEP: Record<TimePeriod, ((date: Date, amount: number) => Date) | null> = {
  "1D": subDays,
  "1W": subWeeks,
  "1M": subMonths,
  "3M": subMonths,
  "6M": subMonths,
  YTD: subYears,
  "1Y": subYears,
  "5Y": subYears,
  ALL: null,
};

export const PERIOD_STEP_AMOUNT: Record<TimePeriod, number> = {
  "1D": 1,
  "1W": 1,
  "1M": 1,
  "3M": 3,
  "6M": 6,
  YTD: 1,
  "1Y": 1,
  "5Y": 5,
  ALL: 0,
};

const intervals: IntervalData[] = [
  {
    code: "1D",
    description: intervalDescriptions["1D"],
    calculateRange: (anchor) => ({ from: subDays(anchor, 1), to: anchor }),
  },
  {
    code: "1W",
    description: intervalDescriptions["1W"],
    calculateRange: (anchor) => ({ from: subWeeks(anchor, 1), to: anchor }),
  },
  {
    code: "1M",
    description: intervalDescriptions["1M"],
    calculateRange: (anchor) => ({ from: subMonths(anchor, 1), to: anchor }),
  },
  {
    code: "3M",
    description: intervalDescriptions["3M"],
    calculateRange: (anchor) => ({ from: subMonths(anchor, 3), to: anchor }),
  },
  {
    code: "6M",
    description: intervalDescriptions["6M"],
    calculateRange: (anchor) => ({ from: subMonths(anchor, 6), to: anchor }),
  },
  {
    code: "YTD",
    description: intervalDescriptions.YTD,
    calculateRange: (anchor) => ({ from: startOfYear(anchor), to: anchor }),
  },
  {
    code: "1Y",
    description: intervalDescriptions["1Y"],
    calculateRange: (anchor) => ({ from: subYears(anchor, 1), to: anchor }),
  },
  {
    code: "5Y",
    description: intervalDescriptions["5Y"],
    calculateRange: (anchor) => ({ from: subYears(anchor, 5), to: anchor }),
  },
  {
    code: "ALL",
    description: intervalDescriptions.ALL,
    calculateRange: (anchor) => ({ from: new Date("1970-01-01"), to: anchor }),
  },
];

const DEFAULT_INTERVAL_CODE: TimePeriod = "3M";

/** Get interval data for a given period code */
const getIntervalData = (code: TimePeriod) => {
  return intervals.find((i) => i.code === code) ?? intervals.find((i) => i.code === DEFAULT_INTERVAL_CODE)!;
};

interface IntervalSelectorProps {
  onIntervalSelect: (code: TimePeriod, description: string, range: DateRange | undefined) => void;
  className?: string;
  isLoading?: boolean;
  defaultValue?: TimePeriod;
  /** LocalStorage key to persist selection. When provided, selection is persisted. */
  storageKey?: string;
  /** Optional callback for haptic feedback */
  onHaptic?: () => void;
}

const IntervalSelector: React.FC<IntervalSelectorProps> = ({
  onIntervalSelect,
  className,
  defaultValue = DEFAULT_INTERVAL_CODE,
  storageKey,
  onHaptic,
}) => {
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  // State for selection - persisted or local
  const [persistedValue, setPersistedValue] = usePersistentState<TimePeriod>(
    storageKey ?? "__interval_selector__",
    defaultValue,
  );
  const [localValue, setLocalValue] = useState<TimePeriod>(defaultValue);

  const currentValue = storageKey ? persistedValue : localValue;

  const handleValueChange = useCallback(
    (value: TimePeriod) => {
      // Update state
      if (storageKey) {
        setPersistedValue(value);
      } else {
        setLocalValue(value);
      }
      // Notify parent
      const data = getIntervalData(value);
      onIntervalSelect(data.code, data.description, data.calculateRange(new Date()));
      // Trigger haptic feedback
      onHaptic?.();
    },
    [onIntervalSelect, storageKey, setPersistedValue, onHaptic],
  );

  const items = intervals.map((interval) => ({
    value: interval.code,
    label: t("ui:interval.label." + interval.code, interval.code),
    title: t("ui:interval." + interval.code, interval.description),
  }));

  return (
    <div className={cn("pointer-events-none relative w-full min-w-0", className)}>
      <div
        className={cn(
          "pointer-events-none relative z-30 flex w-full justify-center overflow-x-auto overflow-y-hidden",
          "touch-pan-x snap-x snap-mandatory overscroll-x-contain scroll-smooth",
          "px-2 md:px-0",
          "[&::-webkit-scrollbar]:hidden",
          "[scrollbar-width:none]",
          "[-webkit-overflow-scrolling:touch]",
        )}
      >
        <AnimatedToggleGroup
          items={items}
          value={currentValue}
          onValueChange={handleValueChange}
          size={isMobile ? "compact" : "sm"}
          variant="default"
          className="pointer-events-auto bg-transparent"
        />
      </div>
    </div>
  );
};

/**
 * Helper to get interval data for a given code - use to derive range/description
 * from a code. Pass `anchor` to compute the range as of an earlier date (used by
 * period-navigation "previous/next" paging); defaults to now.
 */
const getInitialIntervalData = (code: TimePeriod = DEFAULT_INTERVAL_CODE, anchor: Date = new Date()) => {
  const data = getIntervalData(code);
  return {
    code: data.code,
    description: data.description,
    range: data.calculateRange(anchor),
  };
};

/** Shift `anchor` back by `steps` windows of `code`'s own size (e.g. 1Y steps by a year). */
const shiftPeriodAnchor = (code: TimePeriod, steps: number, anchor: Date = new Date()): Date => {
  const stepFn = PERIOD_STEP[code];
  if (!stepFn || steps === 0) return anchor;
  return stepFn(anchor, PERIOD_STEP_AMOUNT[code] * steps);
};

const MONTH_YEAR_FORMAT = new Intl.DateTimeFormat(undefined, { month: "short", year: "numeric" });

/**
 * "This month"/"past year" style copy only makes sense for the current
 * window; once paged away via the period arrows, show the concrete
 * month(s) instead (e.g. "Jun 2026" or "Jul 2024 – Jul 2025").
 */
const formatPeriodRangeLabel = (range: DateRange | undefined): string | null => {
  if (!range?.from || !range?.to) return null;
  const from = MONTH_YEAR_FORMAT.format(range.from);
  const to = MONTH_YEAR_FORMAT.format(range.to);
  return from === to ? from : `${from} – ${to}`;
};

export { IntervalSelector, getInitialIntervalData, shiftPeriodAnchor, formatPeriodRangeLabel };
