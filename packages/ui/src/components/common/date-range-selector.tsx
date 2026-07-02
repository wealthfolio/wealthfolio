import * as React from "react";
import { format, isSameDay, startOfYear, subDays, subMonths, subYears } from "date-fns";
import { DateRange as DayPickerDateRange } from "react-day-picker";
import { useIsMobile } from "../../hooks/use-mobile";
import { cn } from "../../lib/utils";
import { AnimatedToggleGroup } from "../ui/animated-toggle-group";
import { Button } from "../ui/button";
import { Calendar } from "../ui/calendar";
import { Icons } from "../ui/icons";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { Sheet, SheetContent, SheetFooter, SheetHeader, SheetTitle, SheetTrigger } from "../ui/sheet";

// Define a generic DateRange type for this component
export interface DateRange {
  from: Date | undefined;
  to: Date | undefined;
}

const ranges = [
  {
    label: "1D",
    name: "Last Day",
    getValue: () => ({ from: subDays(new Date(), 1), to: new Date() }),
  },
  {
    label: "1W",
    name: "Last Week",
    getValue: () => ({ from: subDays(new Date(), 7), to: new Date() }),
  },
  {
    label: "1M",
    name: "Last Month",
    getValue: () => ({ from: subMonths(new Date(), 1), to: new Date() }),
  },
  {
    label: "3M",
    name: "Last 3 Months",
    getValue: () => ({ from: subMonths(new Date(), 3), to: new Date() }),
  },
  {
    label: "6M",
    name: "Last 6 Months",
    getValue: () => ({ from: subMonths(new Date(), 6), to: new Date() }),
  },
  {
    label: "YTD",
    name: "Year to Date",
    getValue: () => ({ from: startOfYear(new Date()), to: new Date() }),
  },
  {
    label: "1Y",
    name: "Last Year",
    getValue: () => ({ from: subYears(new Date(), 1), to: new Date() }),
  },
  {
    label: "3Y",
    name: "Last 3 Years",
    getValue: () => ({ from: subYears(new Date(), 3), to: new Date() }),
  },
  {
    label: "5Y",
    name: "Last 5 Years",
    getValue: () => ({ from: subYears(new Date(), 5), to: new Date() }),
  },
  {
    label: "ALL",
    name: "All Time",
    getValue: () => ({ from: new Date(1970, 0, 1), to: new Date() }),
  },
] as const;

type DateRangePresetLabel = (typeof ranges)[number]["label"];

interface DateRangeSelectorProps {
  value: DateRange | undefined;
  onChange: (range: DateRange | undefined) => void;
  hiddenRanges?: readonly DateRangePresetLabel[];
}

function isChineseLocale(): boolean {
  return typeof document !== "undefined" && document.documentElement.lang === "zh-CN";
}

function localizedRangeName(name: string): string {
  if (!isChineseLocale()) return name;
  const names: Record<string, string> = {
    "Last Day": "最近 1 天",
    "Last Week": "最近 1 周",
    "Last Month": "最近 1 个月",
    "Last 3 Months": "最近 3 个月",
    "Last 6 Months": "最近 6 个月",
    "Year to Date": "今年至今",
    "Last Year": "最近 1 年",
    "Last 3 Years": "最近 3 年",
    "Last 5 Years": "最近 5 年",
    "All Time": "全部时间",
  };
  return names[name] ?? name;
}

function localizedRangeLabel(label: DateRangePresetLabel): string {
  if (!isChineseLocale()) return label;
  const labels: Record<DateRangePresetLabel, string> = {
    "1D": "1天",
    "1W": "1周",
    "1M": "1月",
    "3M": "3月",
    "6M": "6月",
    YTD: "今年",
    "1Y": "1年",
    "3Y": "3年",
    "5Y": "5年",
    ALL: "全部",
  };
  return labels[label];
}

function formatRangeDateLabel(date: Date | undefined): string {
  if (!date) return isChineseLocale() ? "未设置" : "Not set";
  if (isChineseLocale()) {
    return new Intl.DateTimeFormat("zh-CN", {
      year: "numeric",
      month: "short",
      day: "numeric",
    }).format(date);
  }
  return format(date, "MMM d, yyyy");
}

export function DateRangeSelector({ value, onChange, hiddenRanges = [] }: DateRangeSelectorProps) {
  const isMobile = useIsMobile();
  const [isCustomPickerOpen, setIsCustomPickerOpen] = React.useState(false);
  const [draftRange, setDraftRange] = React.useState<DateRange | undefined>(value);
  const visibleRanges = ranges.filter((range) => !hiddenRanges.includes(range.label));

  // Helper function to compare dates ignoring time
  const compareDates = (date1: Date | undefined, date2: Date | undefined) => {
    if (!date1 || !date2) return false;
    return isSameDay(date1, date2);
  };

  // Check if current range matches any predefined range and get the selected label
  const getSelectedRange = () => {
    if (!value && visibleRanges.some((range) => range.label === "ALL")) {
      return "ALL";
    }

    const selected = visibleRanges.find((range) => {
      const predefinedRange = range.getValue();
      return compareDates(value?.from, predefinedRange.from) && compareDates(value?.to, predefinedRange.to);
    });
    return selected?.label;
  };

  const selectedLabel = getSelectedRange();
  const isCustomRange = !selectedLabel;
  const isDraftRangeComplete = !draftRange || (!!draftRange.from && !!draftRange.to);
  const allTimeRange = visibleRanges.find((range) => range.label === "ALL")?.getValue();
  const appliedDraftRange = draftRange ?? allTimeRange;

  const handleCustomPickerOpenChange = (open: boolean) => {
    if (open) {
      setDraftRange(value ?? allTimeRange);
    }
    setIsCustomPickerOpen(open);
  };

  const handleApplyDraftRange = () => {
    if (!isDraftRangeComplete) return;
    onChange(appliedDraftRange);
    setIsCustomPickerOpen(false);
  };

  const formatRangeDate = formatRangeDateLabel;

  const triggerButton = (
    <Button
      type="button"
      variant={isCustomRange ? "default" : "ghost"}
      size="sm"
      className={cn(
        "h-8 w-9 rounded-full p-0",
        isCustomRange && "bg-primary text-primary-foreground hover:bg-primary/90",
      )}
      aria-label={isChineseLocale() ? "选择自定义日期范围" : "Choose custom date range"}
    >
      <Icons.Calendar className="h-4 w-4" />
    </Button>
  );

  return (
    <div className="flex items-center space-x-1">
      <AnimatedToggleGroup
        items={visibleRanges.map((range) => ({
          value: range.label,
          label: localizedRangeLabel(range.label),
          title: localizedRangeName(range.name),
        }))}
        value={selectedLabel}
        onValueChange={(newValue) => {
          if (!newValue) {
            return;
          }
          const selectedRange = visibleRanges.find((r) => r.label === newValue);
          if (selectedRange) {
            onChange(selectedRange.getValue());
          }
        }}
        size="sm"
        variant="secondary"
      />

      {isMobile ? (
        <Sheet open={isCustomPickerOpen} onOpenChange={handleCustomPickerOpenChange}>
          <SheetTrigger asChild>{triggerButton}</SheetTrigger>
          <SheetContent side="bottom" className="rounded-t-4xl mx-1 flex max-h-[85vh] flex-col p-0">
            <SheetHeader className="border-border border-b px-6 py-4">
              <SheetTitle>{isChineseLocale() ? "自定义范围" : "Custom range"}</SheetTitle>
            </SheetHeader>

            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
              <div className="grid grid-cols-2 gap-3">
                <div className="border-border/70 bg-muted/30 rounded-lg border px-3 py-2">
                  <div className="text-muted-foreground text-xs font-medium">
                    {isChineseLocale() ? "开始" : "Start"}
                  </div>
                  <div className="text-foreground mt-1 truncate text-sm font-medium">
                    {formatRangeDate(draftRange?.from)}
                  </div>
                </div>
                <div className="border-border/70 bg-muted/30 rounded-lg border px-3 py-2">
                  <div className="text-muted-foreground text-xs font-medium">{isChineseLocale() ? "结束" : "End"}</div>
                  <div className="text-foreground mt-1 truncate text-sm font-medium">
                    {formatRangeDate(draftRange?.to)}
                  </div>
                </div>
              </div>

              <div className="mt-5 flex justify-center">
                <Calendar
                  mode="range"
                  defaultMonth={draftRange?.from}
                  selected={draftRange as DayPickerDateRange | undefined}
                  onSelect={(selectedRange: DayPickerDateRange | undefined) => {
                    setDraftRange(selectedRange as DateRange | undefined);
                  }}
                  numberOfMonths={1}
                  className="p-0 [--cell-size:2.5rem]"
                />
              </div>
            </div>

            <SheetFooter className="border-border flex-row gap-2 border-t px-6 py-4 pb-[calc(env(safe-area-inset-bottom,0px)+1rem)]">
              <Button
                type="button"
                variant="ghost"
                className="text-muted-foreground hover:text-foreground"
                onClick={() => setDraftRange(allTimeRange)}
                disabled={!draftRange && !allTimeRange}
              >
                {isChineseLocale() ? "清除" : "Clear"}
              </Button>
              <Button
                type="button"
                className="ml-auto"
                onClick={handleApplyDraftRange}
                disabled={!isDraftRangeComplete}
              >
                {isChineseLocale() ? "完成" : "Done"}
              </Button>
            </SheetFooter>
          </SheetContent>
        </Sheet>
      ) : (
        <Popover>
          <PopoverTrigger asChild>{triggerButton}</PopoverTrigger>
          <PopoverContent
            className="max-h-[min(var(--radix-popover-content-available-height,80vh),80vh)] w-auto overflow-y-auto overscroll-contain p-0 [-webkit-overflow-scrolling:touch]"
            align="end"
          >
            <Calendar
              mode="range"
              defaultMonth={value?.from}
              selected={value as DayPickerDateRange | undefined}
              onSelect={(selectedRange: DayPickerDateRange | undefined) => {
                onChange(selectedRange as DateRange | undefined);
              }}
              numberOfMonths={3}
            />
          </PopoverContent>
        </Popover>
      )}
    </div>
  );
}
