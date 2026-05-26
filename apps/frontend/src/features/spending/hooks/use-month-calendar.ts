import { useMemo } from "react";

import { parseLocalDate } from "@/lib/utils";

import type { EventSpendingSummary } from "../types/event";

export interface WeekBar {
  event: EventSpendingSummary;
  startCol: number;
  endCol: number;
  lane: number;
  /** Show event name only when it begins in this week (or first column of a continuation week). */
  showName: boolean;
}

export interface MonthWeek {
  days: Date[];
  bars: WeekBar[];
}

export interface MonthCalendar {
  monthLabel: string;
  monthStart: Date;
  monthEnd: Date;
  weeks: MonthWeek[];
  /** Subset of `events` that intersect this month. */
  monthEvents: EventSpendingSummary[];
}

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

function stripTime(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function endOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0);
}

function diffDays(a: Date, b: Date): number {
  return Math.round((a.getTime() - b.getTime()) / 86_400_000);
}

/** Build a Monday-first 6-row × 7-col grid covering the month, including
 *  leading and trailing days from the neighbouring months. */
function buildMonthWeeks(monthStart: Date): Date[][] {
  // JS getDay is Sun=0..Sat=6; convert to Mon=0..Sun=6.
  const offset = (monthStart.getDay() + 6) % 7;
  const gridStart = new Date(monthStart);
  gridStart.setDate(monthStart.getDate() - offset);

  const weeks: Date[][] = [];
  for (let w = 0; w < 6; w++) {
    const row: Date[] = [];
    for (let d = 0; d < 7; d++) {
      const day = new Date(gridStart);
      day.setDate(gridStart.getDate() + w * 7 + d);
      row.push(day);
    }
    weeks.push(row);
  }
  return weeks;
}

/** Lane-assign events within a single week so overlapping bars don't collide. */
function computeWeekBars(events: EventSpendingSummary[], week: Date[]): WeekBar[] {
  const weekStart = week[0];
  const weekEnd = week[6];
  const visible = events
    .map((e) => {
      const s = stripTime(parseLocalDate(e.startDate));
      const ee = stripTime(parseLocalDate(e.endDate));
      if (ee < weekStart || s > weekEnd) return null;
      const startCol = s >= weekStart ? diffDays(s, weekStart) : 0;
      const endCol = ee <= weekEnd ? diffDays(ee, weekStart) : 6;
      const showName = s >= weekStart || startCol === 0;
      return { event: e, startCol, endCol, showName, sortKey: s.getTime() };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .sort((a, b) => a.sortKey - b.sortKey || a.startCol - b.startCol);

  const laneEnds: number[] = [];
  const bars: WeekBar[] = [];
  for (const item of visible) {
    let lane = 0;
    while (lane < laneEnds.length && laneEnds[lane] >= item.startCol) lane++;
    laneEnds[lane] = item.endCol;
    bars.push({
      event: item.event,
      startCol: item.startCol,
      endCol: item.endCol,
      lane,
      showName: item.showName,
    });
  }
  return bars;
}

/**
 * Builds the month grid + event bar layout for `cursor`'s month. Returns
 * weeks already paired with their lane-assigned bars, so the calendar
 * component just iterates.
 */
export function useMonthCalendar(events: EventSpendingSummary[], cursor: Date): MonthCalendar {
  const monthStart = useMemo(() => new Date(cursor.getFullYear(), cursor.getMonth(), 1), [cursor]);
  const monthEnd = useMemo(() => endOfMonth(monthStart), [monthStart]);

  const monthEvents = useMemo(
    () =>
      events.filter((e) => {
        const s = stripTime(parseLocalDate(e.startDate));
        const ee = stripTime(parseLocalDate(e.endDate));
        return s <= monthEnd && ee >= monthStart;
      }),
    [events, monthStart, monthEnd],
  );

  const weeks = useMemo<MonthWeek[]>(
    () =>
      buildMonthWeeks(monthStart).map((days) => ({
        days,
        bars: computeWeekBars(monthEvents, days),
      })),
    [monthStart, monthEvents],
  );

  const monthLabel = `${MONTH_NAMES[cursor.getMonth()]} ${cursor.getFullYear()}`;

  return { monthLabel, monthStart, monthEnd, weeks, monthEvents };
}
