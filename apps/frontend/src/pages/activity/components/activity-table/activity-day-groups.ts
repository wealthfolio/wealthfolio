import type { ActivityDetails } from "@/lib/types";

export interface ActivityDayGroup<T> {
  /** The date the group's rows display; also the React key of its header. */
  key: string;
  items: T[];
  /**
   * The account's cash at the end of the day, from a row carrying the
   * server's end-of-day (`DAY`) balance. Every posted row of a day carries the
   * same one, so any of them will do; none when no row does.
   */
  cashBalance: { amount: number; currency: string } | null;
}

/** One entry in the flat, virtualized rendering of a day-grouped list. */
export type ActivityListItem<T> =
  | {
      kind: "header";
      key: string;
      group: ActivityDayGroup<T>;
      /**
       * True for the trailing day only. While more pages are pending it may
       * still be missing rows, so its header leaves the count out.
       */
      isLastGroup: boolean;
    }
  | { kind: "row"; key: string; item: T };

/**
 * Groups runs of consecutive rows that display the same date, in the order the
 * server returned them. The list is only grouped while it runs in date order,
 * so each day is one run; nothing here re-sorts or re-dates a row.
 */
export function groupActivitiesByDay<T>(
  items: T[],
  getActivity: (item: T) => ActivityDetails,
  getDisplayedDate: (activity: ActivityDetails) => string,
): ActivityDayGroup<T>[] {
  const groups: ActivityDayGroup<T>[] = [];
  for (const item of items) {
    const activity = getActivity(item);
    const key = getDisplayedDate(activity);
    let group: ActivityDayGroup<T> | undefined = groups[groups.length - 1];
    if (group?.key !== key) {
      group = { key, items: [], cashBalance: null };
      groups.push(group);
    }
    group.items.push(item);
    if (
      !group.cashBalance &&
      activity.cashBalanceScope === "DAY" &&
      activity.cashBalance != null &&
      activity.cashBalanceCurrency
    ) {
      group.cashBalance = {
        amount: Number(activity.cashBalance),
        currency: activity.cashBalanceCurrency,
      };
    }
  }
  return groups;
}

/** Each header immediately before its own rows: the single index space a virtualizer needs. */
export function flattenActivityDayGroups<T>(
  groups: ActivityDayGroup<T>[],
  getKey: (item: T) => string,
): ActivityListItem<T>[] {
  const out: ActivityListItem<T>[] = [];
  // A key stays put when a page loads below it, so a header keeps its measured
  // height; the counter only keeps keys unique should a date ever recur.
  const seen = new Map<string, number>();
  groups.forEach((group, index) => {
    const repeat = seen.get(group.key) ?? 0;
    seen.set(group.key, repeat + 1);
    out.push({
      kind: "header",
      key: repeat ? `day:${group.key}:${repeat}` : `day:${group.key}`,
      group,
      isLastGroup: index === groups.length - 1,
    });
    for (const item of group.items) {
      out.push({ kind: "row", key: getKey(item), item });
    }
  });
  return out;
}
