import { resolveDisplayTimezone } from "@/lib/utils";

const WEEKDAY_INDEX: Record<string, number> = {
  Mon: 0,
  Tue: 1,
  Wed: 2,
  Thu: 3,
  Fri: 4,
  Sat: 5,
  Sun: 6,
};

export interface ZonedDayHour {
  dayKey: string;
  weekday: number;
  hour: number;
}

export interface ZonedCalendarDate {
  year: number;
  month: number;
  day: number;
}

const DATE_TIME_PART_OPTIONS: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
};

function partValue(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes) {
  return parts.find((part) => part.type === type)?.value;
}

function partNumber(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes) {
  return Number(partValue(parts, type));
}

function pad2(value: number) {
  return String(value).padStart(2, "0");
}

export function getZonedDateParts(date: Date, timezone?: string | null): ZonedCalendarDate {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: resolveDisplayTimezone(timezone),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = formatter.formatToParts(date);
  return {
    year: partNumber(parts, "year"),
    month: partNumber(parts, "month"),
    day: partNumber(parts, "day"),
  };
}

export function localDateParts(date: Date): ZonedCalendarDate {
  return {
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    day: date.getDate(),
  };
}

export function formatZonedDateKey(date: Date, timezone?: string | null): string {
  const parts = getZonedDateParts(date, timezone);
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
}

function timezoneOffsetMs(instant: Date, timezone: string): number {
  const formatter = new Intl.DateTimeFormat("en-US", {
    ...DATE_TIME_PART_OPTIONS,
    timeZone: timezone,
  });
  const parts = formatter.formatToParts(instant);
  let hour = partNumber(parts, "hour");
  if (hour === 24) hour = 0;
  const asUtc = Date.UTC(
    partNumber(parts, "year"),
    partNumber(parts, "month") - 1,
    partNumber(parts, "day"),
    hour,
    partNumber(parts, "minute"),
    partNumber(parts, "second"),
    instant.getUTCMilliseconds(),
  );
  return asUtc - instant.getTime();
}

function zonedWallTimeToUtc(
  date: ZonedCalendarDate,
  timezone: string,
  hour: number,
  minute: number,
  second: number,
  millisecond: number,
): Date {
  const wallAsUtc = Date.UTC(
    date.year,
    date.month - 1,
    date.day,
    hour,
    minute,
    second,
    millisecond,
  );
  let instant = new Date(wallAsUtc);
  for (let i = 0; i < 3; i += 1) {
    const next = new Date(wallAsUtc - timezoneOffsetMs(instant, timezone));
    if (next.getTime() === instant.getTime()) return next;
    instant = next;
  }
  return instant;
}

export function zonedCalendarDateBoundaryToDate(
  date: ZonedCalendarDate,
  boundary: "start" | "end",
  timezone?: string | null,
): Date {
  const tz = resolveDisplayTimezone(timezone);
  return boundary === "start"
    ? zonedWallTimeToUtc(date, tz, 0, 0, 0, 0)
    : zonedWallTimeToUtc(date, tz, 23, 59, 59, 999);
}

export function localDateBoundaryToISOString(
  date: Date,
  boundary: "start" | "end",
  timezone?: string | null,
): string {
  return zonedCalendarDateBoundaryToDate(localDateParts(date), boundary, timezone).toISOString();
}

export function addCalendarMonths(date: ZonedCalendarDate, months: number): ZonedCalendarDate {
  const shifted = new Date(Date.UTC(date.year, date.month - 1 + months, 1));
  const year = shifted.getUTCFullYear();
  const month = shifted.getUTCMonth() + 1;
  return {
    year,
    month,
    day: Math.min(date.day, daysInCalendarMonth(year, month)),
  };
}

export function addCalendarDays(date: ZonedCalendarDate, days: number): ZonedCalendarDate {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

export function daysInCalendarMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function calendarDaysBetweenInclusive(
  start: ZonedCalendarDate,
  end: ZonedCalendarDate,
): number {
  const startUtc = Date.UTC(start.year, start.month - 1, start.day);
  const endUtc = Date.UTC(end.year, end.month - 1, end.day);
  return Math.round((endUtc - startUtc) / (1000 * 60 * 60 * 24)) + 1;
}

export function calendarMonthsBetweenInclusive(
  start: ZonedCalendarDate,
  end: ZonedCalendarDate,
): number {
  return (end.year - start.year) * 12 + (end.month - start.month) + 1;
}

export function createZonedDayHourFormatter(
  timezone?: string | null,
): (date: Date) => ZonedDayHour | null {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: resolveDisplayTimezone(timezone),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    hourCycle: "h23",
  });

  return (date: Date) => {
    if (Number.isNaN(date.getTime())) return null;

    const parts = formatter.formatToParts(date);
    const year = partValue(parts, "year");
    const month = partValue(parts, "month");
    const day = partValue(parts, "day");
    const weekdayName = partValue(parts, "weekday");
    const hour = Number(partValue(parts, "hour"));
    const weekday = weekdayName ? WEEKDAY_INDEX[weekdayName] : undefined;

    if (!year || !month || !day || weekday === undefined || !Number.isFinite(hour)) {
      return null;
    }

    return {
      dayKey: `${year}-${month}-${day}`,
      weekday,
      hour,
    };
  };
}
