import type { DateRange } from "@/lib/types";
import { formatDateISO } from "@/lib/utils";
import type { DayBucket } from "../types/report";
import { localDateFromParts } from "./month-period";
import {
  addCalendarDays,
  addCalendarMonths,
  calendarDaysBetweenInclusive,
  localDateParts,
} from "./timezone";

interface ComparisonBucket {
  key: string;
  from: string;
  to: string;
  value: number;
  future: boolean;
}

export interface ComparisonChartRow {
  key: string;
  label: string;
  value: number | null;
  future: boolean;
  from?: string;
  to?: string;
  priorValue: number | null;
  priorFrom?: string;
  priorTo?: string;
}

// Align each window by its own day/week/month position, retaining every bucket
// from either period (including a 31st day absent from the other month).
export function comparisonBuckets(
  rows: DayBucket[],
  range: DateRange | undefined,
  granularity: "day" | "week" | "month",
  today: string,
): ComparisonBucket[] {
  if (!range?.from || !range.to) return [];
  const start = localDateParts(range.from);
  const end = localDateParts(range.to);
  const days = calendarDaysBetweenInclusive(start, end);
  if (days <= 0) return [];
  const fromKey = formatDateISO(range.from);
  const toKey = formatDateISO(range.to);
  const count =
    granularity === "day"
      ? days
      : granularity === "week"
        ? Math.ceil(days / 7)
        : (end.year - start.year) * 12 + end.month - start.month + 1;
  const buckets: ComparisonBucket[] = [];
  for (let index = 0; index < count; index++) {
    const first =
      granularity === "month"
        ? addCalendarMonths({ ...start, day: 1 }, index)
        : addCalendarDays(start, index * (granularity === "week" ? 7 : 1));
    const last =
      granularity === "month"
        ? addCalendarDays(addCalendarMonths(first, 1), -1)
        : addCalendarDays(first, granularity === "week" ? 6 : 0);
    const firstKey = formatDateISO(localDateFromParts(first));
    const lastKey = formatDateISO(localDateFromParts(last));
    const from = firstKey < fromKey ? fromKey : firstKey;
    buckets.push({
      key: granularity === "month" ? firstKey.slice(0, 7) : from,
      from,
      to: lastKey > toKey ? toKey : lastKey,
      value: 0,
      future: from > today,
    });
  }
  for (const row of rows) {
    if (row.date < fromKey || row.date > toKey) continue;
    const [year, month, day] = row.date.split("-").map(Number);
    const position = calendarDaysBetweenInclusive(start, { year, month, day }) - 1;
    const index =
      granularity === "month"
        ? (year - start.year) * 12 + month - start.month
        : granularity === "week"
          ? Math.floor(position / 7)
          : position;
    if (buckets[index]) buckets[index].value += row.outflow;
  }
  return buckets;
}
