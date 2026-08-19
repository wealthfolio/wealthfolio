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
} from "react-aria-components";

import { cn } from "../../lib/utils";

interface BaseCalendarProps {
  className?: string;
}

type CalendarProps = ComponentProps<typeof CalendarRac> & BaseCalendarProps;
type RangeCalendarProps = ComponentProps<typeof RangeCalendarRac> & BaseCalendarProps;

function CalendarHeader() {
  const { t } = useTranslation();
  return (
    <header className="flex w-full items-center gap-1 pb-1">
      <Button
        slot="previous"
        aria-label={t("ui:datePicker.previousMonth", "Previous month")}
        className="text-muted-foreground/80 hover:bg-accent hover:text-foreground focus-visible:ring-ring/50 flex size-9 items-center justify-center rounded-md outline-none transition-[color,box-shadow] focus-visible:ring-[3px]"
      >
        <Icons.ChevronLeft size={16} />
      </Button>
      <HeadingRac className="grow text-center text-sm font-medium" />
      <Button
        slot="next"
        aria-label={t("ui:datePicker.nextMonth", "Next month")}
        className="text-muted-foreground/80 hover:bg-accent hover:text-foreground focus-visible:ring-ring/50 flex size-9 items-center justify-center rounded-md outline-none transition-[color,box-shadow] focus-visible:ring-[3px]"
      >
        <Icons.ChevronRight size={16} />
      </Button>
    </header>
  );
}

function CalendarGridComponent({ isRange = false }: { isRange?: boolean }) {
  const now = today(getLocalTimeZone());

  return (
    <CalendarGridRac>
      <CalendarGridHeaderRac>
        {(day) => (
          <CalendarHeaderCellRac className="text-muted-foreground/80 size-9 rounded-md p-0 text-xs font-medium">
            {day}
          </CalendarHeaderCellRac>
        )}
      </CalendarGridHeaderRac>
      <CalendarGridBodyRac className="[&_td]:px-0 [&_td]:py-px">
        {(date) => (
          <CalendarCellRac date={date}>
            {/* Checks if date is outside currently displaying month and grays out */}
            {({ isOutsideMonth, formattedDate }) =>
              isOutsideMonth ? (
                <div
                  className={cn(
                    "data-hovered:bg-accent data-selected:bg-primary data-hovered:text-foreground data-selected:text-primary-foreground data-focus-visible:ring-ring/50 text-secondary data-disabled:pointer-events-none data-disabled:opacity-30 data-focus-visible:z-10 data-focus-visible:ring-[3px] data-unavailable:pointer-events-none data-unavailable:line-through data-unavailable:opacity-30 relative flex size-9 cursor-default items-center justify-center whitespace-nowrap rounded-md p-0 text-sm font-normal outline-none",
                  )}
                >
                  {formattedDate}
                </div>
              ) : (
                <div
                  className={cn(
                    "data-hovered:bg-accent data-selected:bg-primary data-hovered:text-foreground data-selected:text-primary-foreground data-focus-visible:ring-ring/50 text-foreground hover:bg-secondary data-disabled:pointer-events-none data-disabled:opacity-30 data-focus-visible:z-10 data-focus-visible:ring-[3px] data-unavailable:pointer-events-none data-unavailable:line-through data-unavailable:opacity-30 relative flex size-9 items-center justify-center whitespace-nowrap rounded-md p-0 text-sm font-normal outline-none transition-colors duration-150",
                    isRange &&
                      "data-selected:bg-accent data-selected:text-foreground data-invalid:data-selection-end:bg-destructive data-invalid:data-selection-start:bg-destructive data-selection-end:bg-primary data-selection-start:bg-primary data-selection-end:text-primary-foreground data-selection-start:text-primary-foreground data-invalid:bg-red-100 data-selected:rounded-none data-selection-end:rounded-e-md data-invalid:data-selection-end:text-white data-selection-start:rounded-s-md data-invalid:data-selection-start:text-white",
                    date.compare(now) === 0 &&
                      cn(
                        "after:bg-primary after:pointer-events-none after:absolute after:bottom-1 after:start-1/2 after:z-10 after:size-[3px] after:-translate-x-1/2 after:rounded-full",
                        isRange
                          ? "data-selection-end:after:bg-background data-selection-start:after:bg-background"
                          : "data-selected:after:bg-background",
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

function Calendar({ className, ...props }: CalendarProps) {
  return (
    <CalendarRac {...props} className={composeRenderProps(className, (className) => cn("w-fit", className))}>
      <CalendarHeader />
      <CalendarGridComponent />
    </CalendarRac>
  );
}

function RangeCalendar({ className, ...props }: RangeCalendarProps) {
  return (
    <RangeCalendarRac {...props} className={composeRenderProps(className, (className) => cn("w-fit", className))}>
      <CalendarHeader />
      <CalendarGridComponent isRange />
    </RangeCalendarRac>
  );
}

export { Calendar, RangeCalendar };
