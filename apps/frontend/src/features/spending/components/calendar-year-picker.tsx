import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Button, Icons, useDateFormatting } from "@wealthfolio/ui";

import { MIN_CALENDAR_YEAR, yearLabel } from "../lib/year-period";

interface CalendarYearPickerProps {
  value: number | null;
  maxYear: number;
  onChange: (year: number) => void;
}

export function CalendarYearPicker({ value, maxYear, onChange }: CalendarYearPickerProps) {
  const { t } = useTranslation();
  const formatting = useDateFormatting();
  const [page, setPage] = useState(() =>
    Math.max(0, Math.floor((maxYear - (value ?? maxYear)) / 9)),
  );
  const last = maxYear - page * 9;
  const first = Math.max(MIN_CALENDAR_YEAR, last - 8);

  return (
    <div className="p-4" data-slot="calendar-year-picker">
      <div className="mb-2 flex items-center justify-between">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-11 sm:size-8"
          aria-label={t("spending:period.previousYears")}
          disabled={first <= MIN_CALENDAR_YEAR}
          onClick={() => setPage((current) => current + 1)}
        >
          <Icons.ChevronLeft className="size-4 rtl:rotate-180" />
        </Button>
        <span className="text-muted-foreground text-xs" aria-live="polite">
          {yearLabel(first, formatting)}–{yearLabel(last, formatting)}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-11 sm:size-8"
          aria-label={t("spending:period.nextYears")}
          disabled={page === 0}
          onClick={() => setPage((current) => current - 1)}
        >
          <Icons.ChevronRight className="size-4 rtl:rotate-180" />
        </Button>
      </div>
      <div className="grid grid-cols-3 gap-2">
        {Array.from({ length: Math.max(0, last - first + 1) }, (_, index) => last - index).map(
          (year) => (
            <Button
              key={year}
              type="button"
              variant={year === value ? "default" : "ghost"}
              className="h-11 rounded-full text-sm font-normal"
              aria-pressed={year === value}
              onClick={() => onChange(year)}
            >
              {yearLabel(year, formatting)}
            </Button>
          ),
        )}
      </div>
    </div>
  );
}
