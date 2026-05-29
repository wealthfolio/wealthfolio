import { format, parse, subMonths, addMonths } from "date-fns";
import { ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import { useMemo, useState } from "react";

import { Button, MonthYearPicker, Popover, PopoverContent, PopoverTrigger } from "@wealthfolio/ui";

interface MonthSwitcherProps {
  selectedMonth: string; // YYYY-MM
  onMonthChange: (month: string) => void;
  availableMonths: string[]; // sorted descending
}

export function MonthSwitcher({
  selectedMonth,
  onMonthChange,
  availableMonths,
}: MonthSwitcherProps) {
  const [open, setOpen] = useState(false);

  const selectedDate = useMemo(() => parse(selectedMonth, "yyyy-MM", new Date()), [selectedMonth]);
  const displayLabel = useMemo(() => format(selectedDate, "MMMM yyyy"), [selectedDate]);

  const canGoNext = useMemo(() => {
    const next = format(addMonths(selectedDate, 1), "yyyy-MM");
    const cur = format(new Date(), "yyyy-MM");
    return next <= cur;
  }, [selectedDate]);

  const canGoPrev = useMemo(() => {
    if (availableMonths.length === 0) return false;
    const prev = format(subMonths(selectedDate, 1), "yyyy-MM");
    return availableMonths.includes(prev);
  }, [selectedDate, availableMonths]);

  const { minDate, maxDate } = useMemo(() => {
    if (availableMonths.length === 0) {
      return { minDate: undefined, maxDate: format(new Date(), "yyyy-MM") };
    }
    return {
      minDate: availableMonths[availableMonths.length - 1],
      maxDate: availableMonths[0],
    };
  }, [availableMonths]);

  return (
    <div className="flex items-center gap-2">
      <Button
        variant="outline"
        size="icon"
        onClick={() => onMonthChange(format(subMonths(selectedDate, 1), "yyyy-MM"))}
        disabled={!canGoPrev}
        className="h-8 w-8"
      >
        <ChevronLeft className="h-4 w-4" />
      </Button>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button variant="outline" className="h-8 w-[160px] justify-between">
            <span>{displayLabel}</span>
            <ChevronDown className="h-4 w-4 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="center">
          <MonthYearPicker
            value={selectedMonth}
            onChange={(m: string) => {
              onMonthChange(m);
              setOpen(false);
            }}
            minDate={minDate}
            maxDate={maxDate}
          />
        </PopoverContent>
      </Popover>
      <Button
        variant="outline"
        size="icon"
        onClick={() => onMonthChange(format(addMonths(selectedDate, 1), "yyyy-MM"))}
        disabled={!canGoNext}
        className="h-8 w-8"
      >
        <ChevronRight className="h-4 w-4" />
      </Button>
    </div>
  );
}

export function getDefaultReportMonth(availableMonths: string[]): string {
  const now = new Date();
  const currentMonth = format(now, "yyyy-MM");
  const lastMonth = format(subMonths(now, 1), "yyyy-MM");
  if (availableMonths.length > 0) {
    const mostRecent = availableMonths[0];
    if (mostRecent === currentMonth && availableMonths.length > 1) return availableMonths[1];
    return mostRecent;
  }
  return lastMonth;
}
