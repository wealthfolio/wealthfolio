import { describe, expect, it } from "vitest";

import type { ActivityTaxonomyAssignment } from "../types/cash-activity";
import type { ActivityLabel, ActivityLabelFilter } from "../types/insight";
import { labelFilterKeeps } from "./label-filter";

const payee = (categoryId: string): ActivityLabel => ({
  kind: "category",
  taxonomyId: "payees",
  categoryId,
});
const activity = (payeeId: string | null, eventId: string | null = null) => ({
  assignments: payeeId
    ? [{ taxonomyId: "payees", categoryId: payeeId } as ActivityTaxonomyAssignment]
    : [],
  eventId,
});
const typeByEvent = new Map([["trip-1", "travel"]]);

describe("labelFilterKeeps", () => {
  it("keeps only activities carrying an included label", () => {
    const filter: ActivityLabelFilter = { include: [payee("bakery")] };

    expect(labelFilterKeeps(filter, activity("bakery"), typeByEvent)).toBe(true);
    expect(labelFilterKeeps(filter, activity("water"), typeByEvent)).toBe(false);
    expect(labelFilterKeeps(filter, activity(null), typeByEvent)).toBe(false);
  });

  it("drops activities carrying an excluded label, included or not", () => {
    const filter: ActivityLabelFilter = {
      include: [payee("bakery")],
      exclude: [{ kind: "event", eventId: "trip-1" }],
    };

    expect(labelFilterKeeps(filter, activity("bakery", "trip-1"), typeByEvent)).toBe(false);
    expect(labelFilterKeeps(filter, activity("bakery", "trip-2"), typeByEvent)).toBe(true);
    expect(labelFilterKeeps({ exclude: [payee("bakery")] }, activity(null), typeByEvent)).toBe(
      true,
    );
  });

  it("matches an event type through the activity's event", () => {
    const filter: ActivityLabelFilter = { include: [{ kind: "eventType", eventTypeId: "travel" }] };

    expect(labelFilterKeeps(filter, activity(null, "trip-1"), typeByEvent)).toBe(true);
    expect(labelFilterKeeps(filter, activity(null, "unknown"), typeByEvent)).toBe(false);
    expect(labelFilterKeeps(filter, activity("bakery"), typeByEvent)).toBe(false);
  });
});
