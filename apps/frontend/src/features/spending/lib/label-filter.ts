import type { CashActivity } from "../types/cash-activity";
import type { ActivityLabel, ActivityLabelFilter } from "../types/insight";

type LabelledActivity = Pick<CashActivity, "assignments" | "eventId">;

/**
 * Whether a label filter keeps an activity: it carries at least one included
 * label, when any is given, and no excluded one. Mirrors
 * `ActivityLabelFilter::keeps` in `wealthfolio_spending::insight`, so a list of
 * activities can follow a report narrowed by the same filter.
 *
 * `typeByEvent` maps a spending event to its type.
 */
export function labelFilterKeeps(
  filter: ActivityLabelFilter,
  activity: LabelledActivity,
  typeByEvent: ReadonlyMap<string, string>,
): boolean {
  const carries = (label: ActivityLabel) => {
    if (label.kind === "category") {
      return activity.assignments.some(
        (assignment) =>
          assignment.taxonomyId === label.taxonomyId && assignment.categoryId === label.categoryId,
      );
    }
    if (!activity.eventId) return false;
    if (label.kind === "event") return activity.eventId === label.eventId;
    return typeByEvent.get(activity.eventId) === label.eventTypeId;
  };
  const include = filter.include ?? [];
  const exclude = filter.exclude ?? [];
  return (include.length === 0 || include.some(carries)) && !exclude.some(carries);
}
