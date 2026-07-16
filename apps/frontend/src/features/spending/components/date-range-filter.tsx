import { format } from "date-fns";
import type { DateRange } from "react-day-picker";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";

import {
  Badge,
  Button,
  Calendar,
  Icons,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Separator,
} from "@wealthfolio/ui";
import { cn } from "@/lib/utils";

interface DateRangeFilterProps {
  value: DateRange | undefined;
  onChange: (next: DateRange | undefined) => void;
  title?: string;
}

function summarize(range: DateRange | undefined, t: TFunction): string | null {
  if (!range?.from && !range?.to) return null;
  if (range.from && range.to) {
    return `${format(range.from, "MMM d")} – ${format(range.to, "MMM d")}`;
  }
  if (range.from) {
    return format(range.from, "MMM d, y");
  }
  return range.to ? t("spending:common.until", { date: format(range.to, "MMM d, y") }) : null;
}

export function DateRangeFilter({ value, onChange, title }: DateRangeFilterProps) {
  const { t } = useTranslation();
  const isActive = !!value?.from || !!value?.to;
  const summary = summarize(value, t);
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
