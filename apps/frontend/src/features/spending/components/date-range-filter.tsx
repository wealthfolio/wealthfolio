import { format } from "date-fns";
import type { DateRange } from "react-day-picker";

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

function summarize(range: DateRange | undefined): string | null {
  if (!range?.from) return null;
  if (range.to) {
    return `${format(range.from, "MMM d")} – ${format(range.to, "MMM d")}`;
  }
  return format(range.from, "MMM d, y");
}

export function DateRangeFilter({ value, onChange, title = "Date" }: DateRangeFilterProps) {
  const isActive = !!value?.from;
  const summary = summarize(value);

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
          {title}
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
          defaultMonth={value?.from}
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
              Clear
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
