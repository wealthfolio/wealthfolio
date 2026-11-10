import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import type { DateRange as CalendarRange } from "react-day-picker";

import type { DateRange } from "@/lib/types";
import { cn, formatDateISO } from "@/lib/utils";
import {
  Button,
  Calendar,
  Icons,
  Input,
  Label,
  MonthYearPicker,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
  useIsMobile,
} from "@wealthfolio/ui";

import {
  parseSpendingDate,
  spendingRangeFromParams,
  SPENDING_RANGE_FROM_PARAM,
  SPENDING_RANGE_TO_PARAM,
} from "../lib/date-range-params";
import { monthRange } from "../lib/month-period";
import { yearRange } from "../lib/year-period";
import { CalendarYearPicker } from "./calendar-year-picker";

interface SpendingDatePickerProps {
  customMonth: string | null;
  customRange?: DateRange;
  customYear?: number | null;
  maxYear?: number;
  onCustomYearChange?: (year: number | null) => void;
  selectionLabel?: string;
  maxMonth: string;
  onCustomMonthChange: (month: string | null) => void;
  onCustomRangeChange?: (range: DateRange | undefined) => void;
  /** "header" draws the trigger as the page-header date selector does: a plain icon button. */
  appearance?: "chart" | "header";
}

export function SpendingDatePicker({
  customMonth,
  customRange,
  customYear = null,
  maxYear,
  onCustomYearChange,
  selectionLabel,
  maxMonth,
  onCustomMonthChange,
  onCustomRangeChange,
  appearance = "chart",
}: SpendingDatePickerProps) {
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState("month");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [viewMonth, setViewMonth] = useState<Date>();
  const active = !!customMonth || !!customRange || customYear !== null;
  const selected = {
    from: parseSpendingDate(from) ?? undefined,
    to: parseSpendingDate(to) ?? undefined,
  };
  const completeRange = spendingRangeFromParams(
    new URLSearchParams({ [SPENDING_RANGE_FROM_PARAM]: from, [SPENDING_RANGE_TO_PARAM]: to }),
  );
  const reversed = !!selected.from && !!selected.to && selected.from > selected.to;

  const handleOpenChange = (next: boolean) => {
    if (next) {
      const initial =
        customRange ??
        (customYear !== null
          ? yearRange(customYear)
          : customMonth
            ? monthRange(customMonth)
            : undefined);
      setMode(customRange ? "range" : customYear !== null ? "year" : "month");
      setFrom(initial?.from ? formatDateISO(initial.from) : "");
      setTo(initial?.to ? formatDateISO(initial.to) : "");
      setViewMonth(initial?.from ?? new Date());
    }
    setOpen(next);
  };
  const clear = () => {
    if (customYear !== null) onCustomYearChange?.(null);
    else if (customRange) onCustomRangeChange?.(undefined);
    else onCustomMonthChange(null);
    setOpen(false);
  };
  const trigger = (
    <Button
      type="button"
      data-no-swipe-drag
      variant={selectionLabel ? "ghost" : active ? "default" : "ghost"}
      // icon-xs keeps the icon button the size of the period pills beside it on a
      // phone, with an invisible 48px tap area, where icon grows it to 44px.
      size={selectionLabel ? "sm" : "icon-xs"}
      className={cn(
        "shrink-0 rounded-full",
        selectionLabel && "h-11 gap-1 px-2 font-medium sm:h-8",
        !selectionLabel && (appearance === "header" ? "w-9" : !active && "bg-muted"),
      )}
      aria-label={
        selectionLabel
          ? `${selectionLabel}, ${t("spending:period.selectDates")}`
          : t("spending:period.selectDates")
      }
    >
      {selectionLabel ? (
        <>
          <span>{selectionLabel}</span>
          <Icons.ChevronDown className="size-3" />
        </>
      ) : (
        <Icons.Calendar className="h-4 w-4" />
      )}
    </Button>
  );
  const content = (
    <div>
      {onCustomYearChange && mode !== "range" && (
        <div
          className="flex gap-5 px-4 pt-1"
          role="group"
          aria-label={t("spending:period.selectDates")}
        >
          {(["month", "year"] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={mode === value}
              onClick={() => setMode(value)}
              className={cn(
                "min-h-11 border-b-2 px-1 text-sm",
                mode === value
                  ? "text-foreground border-current font-medium"
                  : "text-muted-foreground border-transparent",
              )}
            >
              {t(value === "month" ? "spending:period.month" : "spending:period.year")}
            </button>
          ))}
        </div>
      )}
      {mode === "month" ? (
        <div className="p-4">
          <MonthYearPicker
            value={customMonth ?? (customYear !== null ? `${customYear}-01` : maxMonth)}
            highlightSelection={customYear === null}
            maxDate={maxMonth}
            className="w-full max-w-none p-0 [&_.grid_button]:h-11"
            onChange={(month) => {
              onCustomMonthChange(month);
              setOpen(false);
            }}
          />
        </div>
      ) : mode === "year" && onCustomYearChange && maxYear !== undefined ? (
        <CalendarYearPicker
          value={customYear}
          maxYear={maxYear}
          onChange={(year) => {
            onCustomYearChange(year);
            setOpen(false);
          }}
        />
      ) : (
        <div>
          <div className="grid grid-cols-2 gap-4 px-5 pt-5">
            <div className="min-w-0 space-y-1">
              <Label className="text-muted-foreground text-xs font-normal" htmlFor={`${id}-from`}>
                {t("spending:period.startDate")}
              </Label>
              <Input
                id={`${id}-from`}
                type="date"
                value={from}
                className="h-9 min-w-0 bg-transparent text-sm shadow-none"
                aria-invalid={reversed}
                onChange={(event) => {
                  setFrom(event.target.value);
                  const date = parseSpendingDate(event.target.value);
                  if (date) setViewMonth(date);
                }}
              />
            </div>
            <div className="min-w-0 space-y-1">
              <Label className="text-muted-foreground text-xs font-normal" htmlFor={`${id}-to`}>
                {t("spending:period.endDate")}
              </Label>
              <Input
                id={`${id}-to`}
                type="date"
                value={to}
                className="h-9 min-w-0 bg-transparent text-sm shadow-none"
                aria-invalid={reversed}
                onChange={(event) => {
                  setTo(event.target.value);
                  const date = parseSpendingDate(event.target.value);
                  if (date) setViewMonth(date);
                }}
              />
            </div>
          </div>
          {reversed && (
            <p role="alert" className="text-destructive px-4 pt-2 text-xs">
              {t("spending:period.invalidRange")}
            </p>
          )}
          <div className="flex justify-center px-2 pt-3 pb-2">
            <Calendar
              mode="range"
              className="bg-transparent"
              showOutsideDays={false}
              month={viewMonth}
              onMonthChange={setViewMonth}
              selected={selected as CalendarRange}
              numberOfMonths={isMobile ? 1 : 2}
              onSelect={(range) => {
                setFrom(range?.from ? formatDateISO(range.from) : "");
                setTo(range?.to ? formatDateISO(range.to) : "");
              }}
            />
          </div>
        </div>
      )}
      <div className="border-border/60 flex items-center gap-1 border-t px-4 py-3">
        {onCustomRangeChange && (
          <button
            type="button"
            onClick={() => setMode(mode === "range" ? "month" : "range")}
            className="text-muted-foreground hover:text-foreground focus-visible:ring-ring me-auto rounded-sm text-xs whitespace-nowrap underline decoration-current/40 underline-offset-4 transition-colors focus-visible:ring-2 focus-visible:outline-none"
          >
            {t(
              mode !== "range"
                ? "spending:period.chooseCustomDates"
                : "spending:period.chooseMonth",
            )}
          </button>
        )}
        {active && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8 px-2 text-xs"
            onClick={clear}
          >
            {t("common:clear")}
          </Button>
        )}
        {mode === "range" && (
          <>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 px-2 text-xs"
              onClick={() => setOpen(false)}
            >
              {t("common:cancel")}
            </Button>
            <Button
              type="button"
              size="sm"
              className="h-8 px-3 text-xs"
              disabled={!completeRange}
              onClick={() => {
                if (completeRange) {
                  onCustomRangeChange?.(completeRange);
                  setOpen(false);
                }
              }}
            >
              {t("common:apply")}
            </Button>
          </>
        )}
      </div>
    </div>
  );

  return isMobile ? (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      <SheetTrigger render={trigger} />
      <SheetContent
        side="bottom"
        className="mx-1 overflow-y-auto rounded-t-4xl p-0 pb-2 [--overlay-max-height:90dvh]"
      >
        <SheetHeader className="border-border border-b px-5 py-4">
          <SheetTitle>{t("spending:period.selectDates")}</SheetTitle>
        </SheetHeader>
        {content}
      </SheetContent>
    </Sheet>
  ) : (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger render={trigger} />
      <PopoverContent
        align="end"
        className={cn(
          "max-h-[var(--available-height)] overflow-y-auto p-0",
          mode === "range" ? "w-auto" : "w-72",
        )}
      >
        {content}
      </PopoverContent>
    </Popover>
  );
}
