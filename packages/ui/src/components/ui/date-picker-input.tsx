import { CalendarDate, CalendarDateTime, getLocalTimeZone, parseDate, parseDateTime } from "@internationalized/date";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { Icons } from "./icons";
import {
  Button,
  DateValue,
  Dialog,
  Group,
  Popover,
  DatePicker as RacDatePicker,
  DatePickerProps as RacDatePickerProps,
} from "react-aria-components";

import { Calendar } from "./calendar-rac";
import { DateInput } from "./datefield-rac";
import { cn } from "../../lib/utils";

function toDateValue(
  value: Date | string | undefined,
  granularity: "day" | "hour" | "minute" | "second",
): DateValue | null {
  if (!value) return null;

  const hasTimeGranularity = granularity !== "day";

  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) return null;

    if (hasTimeGranularity) {
      return new CalendarDateTime(
        value.getFullYear(),
        value.getMonth() + 1,
        value.getDate(),
        value.getHours(),
        value.getMinutes(),
        value.getSeconds(),
        value.getMilliseconds(),
      );
    } else {
      return new CalendarDate(value.getFullYear(), value.getMonth() + 1, value.getDate());
    }
  }

  if (typeof value === "string") {
    try {
      if (hasTimeGranularity) {
        try {
          return parseDateTime(value);
        } catch (_e) {
          const datePart = parseDate(value);
          return new CalendarDateTime(datePart.year, datePart.month, datePart.day, 0, 0, 0, 0);
        }
      } else {
        return parseDate(value);
      }
    } catch (error) {
      console.error(`Invalid date string format for granularity "${granularity}":`, value, error);
      return null;
    }
  }
  return null;
}

function fromDateValue(value: DateValue | null): Date | undefined {
  if (value) {
    return value.toDate(getLocalTimeZone());
  }
  return undefined;
}

interface DatePickerInputProps extends Omit<
  RacDatePickerProps<DateValue>,
  "value" | "onChange" | "children" | "className" | "granularity"
> {
  onChange: (date: Date | undefined) => void;
  value?: string | Date;
  disabled?: boolean;
  className?: string;
  enableTime?: boolean;
  timeGranularity?: "hour" | "minute" | "second";
  onInteractionEnd?: () => void;
  "data-testid"?: string;
}

export function DatePickerInput({
  onChange,
  value,
  disabled,
  className,
  enableTime,
  timeGranularity,
  onInteractionEnd,
  "data-testid": testId,
  ...props
}: DatePickerInputProps) {
  const { t } = useTranslation();
  const actualGranularity = React.useMemo(() => {
    if (enableTime) {
      return timeGranularity || "minute";
    }
    return "day";
  }, [enableTime, timeGranularity]);

  const racValue = React.useMemo(() => toDateValue(value, actualGranularity), [value, actualGranularity]);

  const handleRacChange = React.useCallback(
    (newValue: DateValue | null) => {
      onChange(fromDateValue(newValue));
    },
    [onChange],
  );

  return (
    <RacDatePicker
      value={racValue}
      onChange={handleRacChange}
      isDisabled={disabled}
      granularity={actualGranularity}
      aria-label={t("ui:datePicker.dateLabel", "Date")}
      className={cn(`*:not-first:mt-2`, className)}
      {...props}
    >
      <Group
        className={cn(
          "dark:bg-input/30 border-input ring-offset-background bg-input-bg h-input-height flex w-full flex-nowrap items-center whitespace-nowrap rounded-md border px-3 py-1 text-sm",
          "focus-within:ring-ring focus-within:outline-none focus-within:ring-2 focus-within:ring-offset-2",
          disabled && "cursor-not-allowed opacity-50",
        )}
        data-testid={testId}
      >
        <DateInput
          unstyled
          className="flex-1 border-none bg-transparent outline-none ring-0 focus:ring-0 focus-visible:ring-0 focus-visible:ring-offset-0"
        />
        <Button
          className={cn(
            "text-muted-foreground/80 hover:text-foreground focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2",
            "flex h-6 w-6 items-center justify-center rounded-sm transition-[color]",
            disabled && "pointer-events-none",
          )}
          aria-label={t("ui:datePicker.pick", "Pick a date")}
        >
          <Icons.CalendarIcon size={16} />
        </Button>
      </Group>
      <Popover
        className="bg-background text-popover-foreground data-entering:animate-in data-exiting:animate-out data-entering:fade-in-0 data-exiting:fade-out-0 data-entering:zoom-in-95 data-exiting:zoom-out-95 data-[placement=bottom]:slide-in-from-top-2 data-[placement=left]:slide-in-from-right-2 data-[placement=right]:slide-in-from-left-2 data-[placement=top]:slide-in-from-bottom-2 outline-hidden z-50 rounded-lg border shadow-lg"
        offset={4}
        onOpenChange={(isOpen: boolean) => {
          if (!isOpen && onInteractionEnd) {
            onInteractionEnd();
          }
        }}
      >
        <Dialog className="max-h-[inherit] overflow-auto p-2 outline-none" style={{ pointerEvents: "auto" }}>
          <Calendar />
        </Dialog>
      </Popover>
    </RacDatePicker>
  );
}
