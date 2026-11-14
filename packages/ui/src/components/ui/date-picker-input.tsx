import {
  CalendarDate,
  CalendarDateTime,
  getLocalTimeZone,
  now,
  parseDate,
  parseDateTime,
} from "@internationalized/date";
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
import { Button as UiButton } from "./button";
import { Input } from "./input";
import { usePortalScopeProps } from "./portal-scope";
import { SheetScreen, useInSheetNavigation } from "./sheet-navigation";

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
  /** "row" drops the field chrome for a phone form row, segments at the row's end. */
  appearance?: "field" | "row";
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
  appearance = "field",
  ...props
}: DatePickerInputProps) {
  const { t } = useTranslation();
  const scopeProps = usePortalScopeProps();
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

  // In a phone form's sheet the calendar opens as a screen of that sheet, full
  // size, like the form's other pickers; the date can still be typed.
  const inSheetNavigation = useInSheetNavigation();
  const [calendarScreenOpen, setCalendarScreenOpen] = React.useState(false);

  const calendarButtonClassName = cn(
    "text-muted-foreground/80 hover:text-foreground focus-visible:outline-solid focus-visible:outline-ring focus-visible:outline-2 focus-visible:outline-offset-2",
    "flex h-6 w-6 items-center justify-center rounded-sm transition-[color]",
    disabled && "pointer-events-none",
  );

  const field = (
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
          "dark:bg-input/30 border-input bg-input-bg h-input-height flex w-full flex-nowrap items-center whitespace-nowrap rounded-md border px-3 py-1 text-sm",
          "has-[input:focus-visible]:outline-solid has-[input:focus-visible]:outline-ring has-[input:focus-visible]:outline-2 has-[input:focus-visible]:outline-offset-2 pointer-coarse:has-[input:focus-visible]:-outline-offset-2",
          disabled && "cursor-not-allowed opacity-50",
          appearance === "row" &&
            "h-auto min-h-14 overflow-visible! rounded-none border-0 bg-transparent px-0 text-base dark:bg-transparent",
        )}
        data-testid={testId}
      >
        <DateInput
          unstyled
          className={cn(
            "flex-1 border-none bg-transparent ring-0 outline-none focus:ring-0 focus-visible:ring-0 focus-visible:ring-offset-0",
            appearance === "row" && "ms-auto flex-none [&_[data-type]]:px-0.5!",
          )}
        />
        {inSheetNavigation ? (
          <button
            type="button"
            disabled={disabled}
            onClick={() => setCalendarScreenOpen(true)}
            aria-haspopup="dialog"
            aria-expanded={calendarScreenOpen}
            aria-label={t("ui:datePicker.pick", "Pick a date")}
            // A full touch target at the field's end.
            className={cn(calendarButtonClassName, "-me-3 size-11 rounded-full")}
          >
            <Icons.CalendarIcon size={16} />
          </button>
        ) : (
          <Button className={calendarButtonClassName} aria-label={t("ui:datePicker.pick", "Pick a date")}>
            <Icons.CalendarIcon size={16} />
          </Button>
        )}
      </Group>
      {!inSheetNavigation && (
        <Popover
          {...scopeProps}
          className="bg-background text-popover-foreground data-entering:animate-in data-exiting:animate-out data-entering:fade-in-0 data-exiting:fade-out-0 data-entering:zoom-in-95 data-exiting:zoom-out-95 data-[placement=bottom]:slide-in-from-top-2 data-[placement=left]:slide-in-from-right-2 data-[placement=right]:slide-in-from-left-2 data-[placement=top]:slide-in-from-bottom-2 z-50 rounded-lg border shadow-lg outline-hidden"
          offset={4}
          onOpenChange={(isOpen: boolean) => {
            if (!isOpen && onInteractionEnd) {
              onInteractionEnd();
            }
          }}
        >
          {/* `data-open` marks it as an open popup, as Base UI's are (React Aria
              renders it only while open), so Back closes it first. */}
          <Dialog
            data-open=""
            className="max-h-[inherit] overflow-auto p-2 outline-none"
            style={{ pointerEvents: "auto" }}
          >
            <Calendar />
          </Dialog>
        </Popover>
      )}
    </RacDatePicker>
  );

  if (!inSheetNavigation) return field;

  return (
    <>
      {field}
      <SheetCalendarScreen
        open={calendarScreenOpen}
        onOpenChange={(open) => {
          setCalendarScreenOpen(open);
          if (!open) onInteractionEnd?.();
        }}
        value={racValue}
        onChange={handleRacChange}
        enableTime={actualGranularity !== "day"}
        withSeconds={actualGranularity === "second"}
      />
    </>
  );
}

interface SheetCalendarScreenProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  value: DateValue | null;
  onChange: (value: DateValue | null) => void;
  enableTime: boolean;
  withSeconds: boolean;
}

const pad = (n: number) => String(n).padStart(2, "0");

function SheetCalendarScreen({
  open,
  onOpenChange,
  value,
  onChange,
  enableTime,
  withSeconds,
}: SheetCalendarScreenProps) {
  const { t } = useTranslation();
  const timeId = React.useId();
  const time = value && "hour" in value ? value : null;

  const handleDay = (day: DateValue) => {
    if (!enableTime) {
      onChange(new CalendarDate(day.year, day.month, day.day));
      onOpenChange(false);
      return;
    }
    // Keeps the time already set; the screen stays open so it can be changed.
    const base = time ?? now(getLocalTimeZone());
    onChange(new CalendarDateTime(day.year, day.month, day.day, base.hour, base.minute, withSeconds ? base.second : 0));
  };

  const handleTime = (event: React.ChangeEvent<HTMLInputElement>) => {
    const [hour, minute, second = 0] = event.target.value.split(":").map(Number);
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return;
    const day = value ?? now(getLocalTimeZone());
    onChange(new CalendarDateTime(day.year, day.month, day.day, hour, minute, withSeconds ? second : 0));
  };

  return (
    <SheetScreen open={open} onOpenChange={onOpenChange} title={t("ui:datePicker.dateLabel", "Date")}>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
        <Calendar
          size="large"
          aria-label={t("ui:datePicker.dateLabel", "Date")}
          value={value ? new CalendarDate(value.year, value.month, value.day) : null}
          onChange={handleDay}
        />
        {enableTime && (
          <div className="flex items-center justify-between gap-4 border-t pt-4">
            <label htmlFor={timeId} className="text-base">
              {t("ui:datePicker.time", "Time")}
            </label>
            <Input
              id={timeId}
              type="time"
              step={withSeconds ? 1 : 60}
              value={time ? `${pad(time.hour)}:${pad(time.minute)}${withSeconds ? `:${pad(time.second)}` : ""}` : ""}
              onChange={handleTime}
              className="w-auto"
            />
          </div>
        )}
        {/* Picking a day keeps the screen open for the time, so it needs its own way out. */}
        {enableTime && (
          <UiButton type="button" className="mt-auto w-full" onClick={() => onOpenChange(false)}>
            {t("ui:datePicker.done", "Done")}
          </UiButton>
        )}
      </div>
    </SheetScreen>
  );
}
