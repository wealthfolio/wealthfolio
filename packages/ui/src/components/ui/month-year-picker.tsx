"use client";

import * as React from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "./button";
import { cn } from "../../lib/utils";
import { useDateFormatting } from "../formatting-provider";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const FULL_MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

interface MonthYearPickerProps {
  /** Currently selected month (YYYY-MM format) */
  value?: string;
  /** Callback when month is selected */
  onChange?: (value: string) => void;
  /** Minimum selectable date (YYYY-MM format) */
  minDate?: string;
  /** Maximum selectable date (YYYY-MM format) */
  maxDate?: string;
  /** Additional class name */
  className?: string;
}

function MonthYearPicker({ value, onChange, minDate, maxDate, className }: MonthYearPickerProps) {
  const formatting = useDateFormatting();
  const { t } = useTranslation();
  const [selectedYear, selectedMonth] = React.useMemo(() => {
    if (value) {
      const [year, month] = value.split("-").map(Number);
      return [year, month];
    }
    const now = new Date();
    return [now.getFullYear(), now.getMonth() + 1];
  }, [value]);

  const [viewYear, setViewYear] = React.useState(selectedYear);

  React.useEffect(() => {
    setViewYear(selectedYear);
  }, [selectedYear]);

  const [minYear, minMonth] = React.useMemo(() => {
    if (minDate) {
      const [year, month] = minDate.split("-").map(Number);
      return [year, month];
    }
    return [1970, 1];
  }, [minDate]);

  const [maxYear, maxMonth] = React.useMemo(() => {
    if (maxDate) {
      const [year, month] = maxDate.split("-").map(Number);
      return [year, month];
    }
    const now = new Date();
    return [now.getFullYear(), now.getMonth() + 1];
  }, [maxDate]);

  const canGoPrevYear = viewYear > minYear;
  const canGoNextYear = viewYear < maxYear;
  const monthLabels = React.useMemo(
    () =>
      Array.from({ length: 12 }, (_, index) => {
        const date = { year: 2020, month: index + 1, day: 1 };
        return {
          short: formatting.formatCalendarDate(date, { calendar: "gregory", month: "short" }),
          long: formatting.formatCalendarDate(date, { calendar: "gregory", month: "long" }),
        };
      }),
    [formatting],
  );
  const yearLabel = formatting.formatCalendarDate(
    { year: viewYear, month: 1, day: 1 },
    { calendar: "gregory", year: "numeric" },
  );

  const handlePrevYear = () => {
    if (canGoPrevYear) setViewYear((y) => y - 1);
  };

  const handleNextYear = () => {
    if (canGoNextYear) setViewYear((y) => y + 1);
  };

  const handleMonthClick = (monthIndex: number) => {
    const month = monthIndex + 1;
    const monthStr = String(month).padStart(2, "0");
    onChange?.(`${viewYear}-${monthStr}`);
  };

  const isMonthDisabled = (monthIndex: number) => {
    const month = monthIndex + 1;
    if (viewYear < minYear || (viewYear === minYear && month < minMonth)) return true;
    if (viewYear > maxYear || (viewYear === maxYear && month > maxMonth)) return true;
    return false;
  };

  const isMonthSelected = (monthIndex: number) => {
    const month = monthIndex + 1;
    return viewYear === selectedYear && month === selectedMonth;
  };

  return (
    <div className={cn("w-[240px] p-3", className)} data-slot="month-year-picker">
      <div className="mb-3 flex items-center justify-between">
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          aria-label={t("ui:datePicker.previousYear", "Previous year")}
          onClick={handlePrevYear}
          disabled={!canGoPrevYear}
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <span className="text-sm font-medium">{yearLabel}</span>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          aria-label={t("ui:datePicker.nextYear", "Next year")}
          onClick={handleNextYear}
          disabled={!canGoNextYear}
        >
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
      <div className="grid grid-cols-3 gap-2">
        {monthLabels.map((month, index) => {
          const disabled = isMonthDisabled(index);
          const selected = isMonthSelected(index);
          return (
            <Button
              key={index}
              variant={selected ? "default" : "ghost"}
              size="sm"
              className={cn(
                "h-8 text-xs font-normal",
                disabled && "cursor-not-allowed opacity-50",
                selected && "bg-primary text-primary-foreground",
              )}
              onClick={() => !disabled && handleMonthClick(index)}
              disabled={disabled}
              aria-label={month.long}
            >
              {month.short}
            </Button>
          );
        })}
      </div>
    </div>
  );
}

export { MonthYearPicker, MONTHS, FULL_MONTHS };
