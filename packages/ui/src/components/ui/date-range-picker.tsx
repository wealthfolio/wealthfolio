import { Button } from "./button";
import { Calendar } from "./calendar";
import { Popover, PopoverContent, PopoverTrigger } from "./popover";
import { cn } from "../../lib/utils";
import { format } from "date-fns";
import { Icons } from "./icons";
import { DateRange } from "react-day-picker";
import { useTranslation } from "react-i18next";
import { useDateFnsLocale } from "../../hooks/use-date-fns-locale";

interface DatePickerWithRangeProps {
  date: DateRange | undefined;
  onDateChange: (date: DateRange | undefined) => void;
  className?: string;
}

export function DatePickerWithRange({ date, onDateChange, className }: DatePickerWithRangeProps) {
  const { t } = useTranslation();
  const locale = useDateFnsLocale();
  return (
    <div className={cn("grid gap-2", className)}>
      <Popover>
        <PopoverTrigger asChild>
          <Button
            id="date"
            variant={"outline"}
            className={cn(
              "h-input-height w-[300px] justify-start text-left font-normal",
              !date && "text-muted-foreground",
            )}
          >
            <Icons.CalendarIcon className="mr-2 h-4 w-4" />
            {date?.from ? (
              date.to ? (
                <>
                  {format(date.from, "LLL dd, y", { locale })} - {format(date.to, "LLL dd, y", { locale })}
                </>
              ) : (
                format(date.from, "LLL dd, y", { locale })
              )
            ) : (
              <span>{t("ui:dateRange.pick", "Pick a date range")}</span>
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="start">
          <Calendar mode="range" defaultMonth={date?.from} selected={date} onSelect={onDateChange} numberOfMonths={3} />
        </PopoverContent>
      </Popover>
    </div>
  );
}
