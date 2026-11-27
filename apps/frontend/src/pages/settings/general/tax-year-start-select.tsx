import { useTranslation } from "react-i18next";

import { formatZonedDateKey } from "@/features/spending/lib/timezone";
import {
  formatTaxYearStart,
  lastTaxYearStartDay,
  readTaxYearStart,
  taxYearOf,
  taxYearRange,
} from "@/lib/tax-year";
import { useDateFormatting } from "@wealthfolio/ui";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@wealthfolio/ui/components/ui/select";

const MONTHS = Array.from({ length: 12 }, (_, index) => index + 1);

/** Month and day pickers for the tax year's start, with the current tax year's dates. */
export function TaxYearStartSelect({
  value,
  timezone,
  onChange,
}: {
  value: string | undefined;
  timezone: string;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation();
  const dates = useDateFormatting();
  const start = readTaxYearStart(value);

  // Names and numbers in the formatting locale; 2001 is any non-leap year.
  const monthLabel = (month: number) =>
    dates.formatCalendarDate({ year: 2001, month, day: 1 }, { month: "long" });
  const dayLabel = (day: number) =>
    dates.formatCalendarDate({ year: 2001, month: 1, day }, { day: "numeric" });
  const days = Array.from({ length: lastTaxYearStartDay(start.month) }, (_, index) => index + 1);

  const [year, month, day] = formatZonedDateKey(new Date(), timezone).split("-").map(Number);
  const current = taxYearRange(taxYearOf({ year, month, day }, start), start);
  const longDate = { dateStyle: "long" } as const;

  return (
    <div className="space-y-2">
      <div className="flex w-full max-w-90 gap-2">
        <Select
          value={String(start.month)}
          items={MONTHS.map((month) => ({ value: String(month), label: monthLabel(month) }))}
          onValueChange={(next) => {
            if (next === null) return;
            const month = Number(next);
            // Keep the day where the new month has it (31 March → 30 April).
            onChange(
              formatTaxYearStart({ month, day: Math.min(start.day, lastTaxYearStartDay(month)) }),
            );
          }}
        >
          <SelectTrigger
            className="flex-1"
            aria-label={t("settings:taxYearStart.month")}
            data-testid="tax-year-start-month"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {MONTHS.map((month) => (
              <SelectItem key={month} value={String(month)}>
                {monthLabel(month)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={String(start.day)}
          items={days.map((day) => ({ value: String(day), label: dayLabel(day) }))}
          onValueChange={(next) => {
            if (next !== null)
              onChange(formatTaxYearStart({ month: start.month, day: Number(next) }));
          }}
        >
          <SelectTrigger
            className="w-24"
            aria-label={t("settings:taxYearStart.day")}
            data-testid="tax-year-start-day"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {days.map((day) => (
              <SelectItem key={day} value={String(day)}>
                {dayLabel(day)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <p className="text-muted-foreground text-sm" data-testid="tax-year-start-preview">
        {t("settings:taxYearStart.current", {
          start: dates.formatCalendarDate(current.start, longDate),
          end: dates.formatCalendarDate(current.end, longDate),
        })}
      </p>
    </div>
  );
}
