import type { TFunction } from "i18next";
import type { DateRange } from "react-day-picker";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";
import {
  Badge,
  Button,
  Calendar,
  Icons,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Separator,
  calendarDateFromLocalDate,
  useDateFormatting,
  type FormattingApi,
} from "@wealthfolio/ui";

interface DateRangeFilterProps {
  value: DateRange | undefined;
  onChange: (next: DateRange | undefined) => void;
  title?: string;
}

function summarize(
  range: DateRange | undefined,
  t: TFunction,
  formatting: Pick<FormattingApi, "formatCalendarDate">,
): string | null {
  if (!range?.from && !range?.to) return null;
  if (range.from && range.to) {
    return `${formatting.formatCalendarDate(calendarDateFromLocalDate(range.from), { month: "short", day: "numeric" })} – ${formatting.formatCalendarDate(calendarDateFromLocalDate(range.to), { month: "short", day: "numeric" })}`;
  }
  if (range.from) {
    return formatting.formatCalendarDate(calendarDateFromLocalDate(range.from));
  }
  return range.to
    ? t("spending:common.until", {
        date: formatting.formatCalendarDate(calendarDateFromLocalDate(range.to)),
      })
    : null;
}

export function DateRangeFilter({ value, onChange, title }: DateRangeFilterProps) {
  const formatting = useDateFormatting();
  const { t } = useTranslation();
  const isActive = !!value?.from || !!value?.to;
  const summary = summarize(value, t, formatting);
  const label = title ?? t("common:date");

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={cn(
            "h-8 gap-1.5 rounded-md border-[1.5px] border-none px-3 py-1 text-sm font-medium",
            isActive ? "bg-muted/40" : "shadow-inner-xs bg-muted/90",
          )}
        >
          <Icons.PlusCircle className="mr-2 h-4 w-4" />
          {label}
          {isActive && summary && (
            <>
              <Separator orientation="vertical" className="mx-2 h-4" />
              <Badge variant="secondary" className="text-foreground rounded-sm px-1 font-normal">
                {summary}
              </Badge>
            </>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <Calendar
          mode="range"
          defaultMonth={value?.from ?? value?.to}
          selected={value}
          onSelect={onChange}
          numberOfMonths={2}
        />
        {isActive && (
          <div className="border-border border-t p-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onChange(undefined)}
              className="text-destructive hover:bg-destructive/10 w-full"
            >
              {t("common:clear")}
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
