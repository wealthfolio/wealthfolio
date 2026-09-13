import { useMemo } from "react";

import type { Activity } from "@/lib/types";
import { parseLocalDate } from "@/lib/utils";

import { inclusiveDays } from "../lib/date-utils";
import type { EventSpendingSummary } from "../types/event";
import { computeBaselinePace, type BaselinePeriod } from "./use-baseline-pace";

export interface EventsAggregate {
  totalSpent: number;
  totalEventDays: number;
  normalPace: number;
  lift: number;
  topEventName: string | null;
}

export function computeEventsAggregate(
  events: EventSpendingSummary[],
  heatmapActivities: Activity[],
  accountTypeById?: Map<string, string>,
  dailySpendByDate?: Map<string, number>,
  baselinePeriod?: BaselinePeriod,
): EventsAggregate {
  let totalSpent = 0;
  let totalEventDays = 0;
  let topEvent: EventSpendingSummary | null = null;
  for (const ev of events) {
    totalSpent += ev.totalSpending;
    const days = Math.max(
      1,
      inclusiveDays(parseLocalDate(ev.startDate), parseLocalDate(ev.endDate)),
    );
    totalEventDays += days;
    if (!topEvent || ev.totalSpending > topEvent.totalSpending) topEvent = ev;
  }

  const normalPace = computeBaselinePace(
    heatmapActivities,
    events,
    baselinePeriod?.days ?? 12 * 7,
    accountTypeById,
    dailySpendByDate,
    baselinePeriod,
  );
  const expected = normalPace * totalEventDays;
  const lift = totalSpent - expected;

  return {
    totalSpent,
    totalEventDays,
    normalPace,
    lift,
    topEventName: topEvent?.eventName ?? null,
  };
}

export function useEventsAggregate(
  events: EventSpendingSummary[],
  heatmapActivities: Activity[],
  accountTypeById?: Map<string, string>,
  dailySpendByDate?: Map<string, number>,
  baselinePeriod?: BaselinePeriod,
): EventsAggregate {
  return useMemo(
    () =>
      computeEventsAggregate(
        events,
        heatmapActivities,
        accountTypeById,
        dailySpendByDate,
        baselinePeriod,
      ),
    [events, heatmapActivities, accountTypeById, dailySpendByDate, baselinePeriod],
  );
}
