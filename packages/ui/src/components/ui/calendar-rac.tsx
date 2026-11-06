import { ComponentProps } from "react";
import { getLocalTimeZone, today } from "@internationalized/date";
import { useTranslation } from "react-i18next";
import { Icons } from "./icons";
import {
  Button,
  CalendarCell as CalendarCellRac,
  CalendarGridBody as CalendarGridBodyRac,
  CalendarGridHeader as CalendarGridHeaderRac,
  CalendarGrid as CalendarGridRac,
  CalendarHeaderCell as CalendarHeaderCellRac,
  Calendar as CalendarRac,
  composeRenderProps,
  Heading as HeadingRac,
  RangeCalendar as RangeCalendarRac,
  type CalendarProps as CalendarRacProps,
  type DateValue,
} from "react-aria-components";

import { cn } from "../../lib/utils";

interface BaseCalendarProps {
  className?: string;
  /** "large" fills its container with full-size touch targets, for phone screens. */
  size?: "default" | "large";
}

// Single-date selection; ComponentProps of the generic Calendar widens onChange to every selection mode.
type CalendarProps = CalendarRacProps<DateValue> & BaseCalendarProps;
type RangeCalendarProps = ComponentProps<typeof RangeCalendarRac> & BaseCalendarProps;

function CalendarHeader({ large = false }: { large?: boolean }) {
  const { t } = useTranslation();
  const navButton = cn(
    "text-muted-foreground/80 hover:bg-accent hover:text-foreground focus-visible:outline-ring flex size-9 items-center justify-center rounded-md transition-[color,box-shadow] outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-solid",
    large && "size-11 rounded-full",
  );
  return (
    <header className={cn("flex w-full items-center gap-1 pb-1", large && "pb-3")}>
      <Button slot="previous" aria-label={t("ui:datePicker.previousMonth", "Previous month")} className={navButton}>
        <Icons.ChevronLeft size={16} className="rtl:rotate-180" />
      </Button>
      <HeadingRac className={cn("grow text-center text-sm font-medium", large && "text-base font-semibold")} />
      <Button slot="next" aria-label={t("ui:datePicker.nextMonth", "Next month")} className={navButton}>
        <Icons.ChevronRight size={16} className="rtl:rotate-180" />
      </Button>
    </header>
  );
}

function CalendarGridComponent({ isRange = false, large = false }: { isRange?: boolean; large?: boolean }) {
  const now = today(getLocalTimeZone());
  // Up to 44px, and narrower when seven columns don't fit (a 320px screen leaves 288px).
  const largeCell = large && "mx-auto aspect-square size-auto w-full max-w-11 rounded-full text-base";

  return (
    <CalendarGridRac className={cn(large && "w-full")}>
      <CalendarGridHeaderRac>
        {(day) => (
          <CalendarHeaderCellRac
            className={cn("text-muted-foreground/80 size-9 rounded-md p-0 text-xs font-medium", large && "h-9 w-auto")}
          >
            {day}
          </CalendarHeaderCellRac>
        )}
      </CalendarGridHeaderRac>
      <CalendarGridBodyRac className={cn("[&_td]:px-0 [&_td]:py-px", large && "[&_td]:py-0.5")}>
        {(date) => (
          <CalendarCellRac date={date} className="group outline-none">
            {/* Checks if date is outside currently displaying month and grays out */}
            {({ isOutsideMonth, formattedDate }) =>
              isOutsideMonth ? (
                <div
                  className={cn(
                    "group-data-hovered:bg-accent group-data-selected:bg-primary group-data-hovered:text-foreground group-data-selected:text-primary-foreground group-data-focus-visible:outline-solid group-data-focus-visible:outline-2 group-data-focus-visible:-outline-offset-2 group-data-focus-visible:outline-ring text-secondary group-data-disabled:pointer-events-none group-data-disabled:opacity-30 group-data-focus-visible:z-10 group-data-unavailable:pointer-events-none group-data-unavailable:line-through group-data-unavailable:opacity-30 relative flex size-9 cursor-default items-center justify-center whitespace-nowrap rounded-md p-0 text-sm font-normal outline-none",
                    largeCell,
                  )}
                >
                  {formattedDate}
                </div>
              ) : (
                <div
                  className={cn(
                    "group-data-hovered:bg-accent group-data-selected:bg-primary group-data-hovered:text-foreground group-data-selected:text-primary-foreground group-data-focus-visible:outline-solid group-data-focus-visible:outline-2 group-data-focus-visible:-outline-offset-2 group-data-focus-visible:outline-ring text-foreground hover:bg-secondary group-data-disabled:pointer-events-none group-data-disabled:opacity-30 group-data-focus-visible:z-10 group-data-unavailable:pointer-events-none group-data-unavailable:line-through group-data-unavailable:opacity-30 relative flex size-9 items-center justify-center whitespace-nowrap rounded-md p-0 text-sm font-normal outline-none transition-colors duration-150",
                    largeCell,
                    isRange &&
                      "group-data-selected:bg-accent group-data-selected:text-foreground group-data-invalid:group-data-selection-end:bg-destructive group-data-invalid:group-data-selection-start:bg-destructive group-data-selection-end:bg-primary group-data-selection-start:bg-primary group-data-selection-end:text-primary-foreground group-data-selection-start:text-primary-foreground group-data-invalid:bg-destructive-subtle group-data-selected:rounded-none group-data-selection-end:rounded-e-md group-data-invalid:group-data-selection-end:text-white group-data-selection-start:rounded-s-md group-data-invalid:group-data-selection-start:text-white",
                    date.compare(now) === 0 &&
                      cn(
                        "after:bg-primary after:pointer-events-none after:absolute after:bottom-1 after:left-1/2 after:z-10 after:size-[3px] after:-translate-x-1/2 after:rounded-full",
                        isRange
                          ? "group-data-selection-end:after:bg-background group-data-selection-start:after:bg-background"
                          : "group-data-selected:after:bg-background",
                      ),
                  )}
                >
                  {formattedDate}
                </div>
              )
            }
          </CalendarCellRac>
        )}
      </CalendarGridBodyRac>
    </CalendarGridRac>
  );
}

function Calendar({ className, size = "default", ...props }: CalendarProps) {
  const large = size === "large";
  return (
    <CalendarRac
      {...props}
      className={composeRenderProps(className, (className) => cn(large ? "w-full" : "w-fit", className))}
    >
      <CalendarHeader large={large} />
      <CalendarGridComponent large={large} />
    </CalendarRac>
  );
}

function RangeCalendar({ className, size: _size, ...props }: RangeCalendarProps) {
  return (
    <RangeCalendarRac {...props} className={composeRenderProps(className, (className) => cn("w-fit", className))}>
      <CalendarHeader />
      <CalendarGridComponent isRange />
    </RangeCalendarRac>
  );
}

export { Calendar, RangeCalendar };
