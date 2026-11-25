import type { CashActivity } from "../types/cash-activity";
import type { ActivityLabel, ActivityLabelFilter } from "../types/insight";
import { PAYEES_TAXONOMY_ID } from "./payee";

type LabelledActivity = Pick<CashActivity, "assignments" | "splits" | "eventId">;

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
      // A split activity's categories are its splits', which replace the
      // assignment it has in the same taxonomy.
      const splits = activity.splits.filter((split) => split.taxonomyId === label.taxonomyId);
      if (splits.length > 0) return splits.some((split) => split.categoryId === label.categoryId);
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

/**
 * The Transactions page's URL filters that list exactly what a label filter
 * keeps, or `null` when they cannot. That page narrows by payees and by
 * events, and by both at once only as "and": so it can show a filter that
 * includes payees alone, or events and event types alone (a type being all of
 * its events), and nothing that leaves labels out.
 */
export function labelFilterTransactionParams(
  filter: ActivityLabelFilter | undefined,
  events: readonly { id: string; eventTypeId: string }[],
): { payees?: string; events?: string } | null {
  const include = filter?.include ?? [];
  if ((filter?.exclude ?? []).length > 0) return null;
  if (include.length === 0) return {};
  if (include.every((label) => label.kind === "category")) {
    const payees = include.filter(
      (label) => label.kind === "category" && label.taxonomyId === PAYEES_TAXONOMY_ID,
    );
    if (payees.length !== include.length) return null;
    return { payees: payees.map((label) => label.categoryId).join(",") };
  }
  if (include.some((label) => label.kind === "category")) return null;
  const eventIds = new Set<string>();
  for (const label of include) {
    if (label.kind === "event") eventIds.add(label.eventId);
    if (label.kind === "eventType") {
      for (const event of events) {
        if (event.eventTypeId === label.eventTypeId) eventIds.add(event.id);
      }
    }
  }
  // No event to name: an empty list would read as no filter at all.
  return eventIds.size > 0 ? { events: [...eventIds].join(",") } : null;
}

/**
 * Whether a label filter leaves out every activity tagged to an event, by the
 * event alone: the filter leaves the event or its type out, or keeps only
 * events and event types that this one is not among. Such an event has no
 * place in a report narrowed by the filter. An event whose activities the
 * filter may keep or not by their other labels, like a payee, is not ruled
 * out, even when none of them is kept.
 */
export function labelFilterRulesOutEvent(
  filter: ActivityLabelFilter,
  event: { eventId: string; eventTypeId: string },
): boolean {
  const names = (label: ActivityLabel) =>
    (label.kind === "event" && label.eventId === event.eventId) ||
    (label.kind === "eventType" && label.eventTypeId === event.eventTypeId);
  const include = filter.include ?? [];
  if ((filter.exclude ?? []).some(names)) return true;
  return (
    include.length > 0 &&
    include.every((label) => label.kind !== "category") &&
    !include.some(names)
  );
}
