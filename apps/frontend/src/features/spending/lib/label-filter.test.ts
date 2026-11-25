import { describe, expect, it } from "vitest";

import type { ActivitySplit, ActivityTaxonomyAssignment } from "../types/cash-activity";
import type { ActivityLabel, ActivityLabelFilter } from "../types/insight";
import {
  labelFilterKeeps,
  labelFilterRulesOutEvent,
  labelFilterTransactionParams,
} from "./label-filter";

const payee = (categoryId: string): ActivityLabel => ({
  kind: "category",
  taxonomyId: "payees",
  categoryId,
});
const activity = (payeeId: string | null, eventId: string | null = null) => ({
  assignments: payeeId
    ? [{ taxonomyId: "payees", categoryId: payeeId } as ActivityTaxonomyAssignment]
    : [],
  splits: [] as ActivitySplit[],
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

  it("reads a split activity's categories from its splits, and its payee as before", () => {
    const category = (categoryId: string): ActivityLabel => ({
      kind: "category",
      taxonomyId: "spending_categories",
      categoryId,
    });
    const split = {
      ...activity("bakery"),
      assignments: [
        { taxonomyId: "payees", categoryId: "bakery" },
        { taxonomyId: "spending_categories", categoryId: "household" },
      ] as ActivityTaxonomyAssignment[],
      splits: [
        { taxonomyId: "spending_categories", categoryId: "clothing" },
        { taxonomyId: "spending_categories", categoryId: "gifts" },
      ] as ActivitySplit[],
    };

    expect(labelFilterKeeps({ include: [category("gifts")] }, split, typeByEvent)).toBe(true);
    expect(labelFilterKeeps({ include: [category("household")] }, split, typeByEvent)).toBe(false);
    expect(labelFilterKeeps({ include: [payee("bakery")] }, split, typeByEvent)).toBe(true);
  });
});

describe("labelFilterTransactionParams", () => {
  const events = [
    { id: "trip-1", eventTypeId: "travel" },
    { id: "trip-2", eventTypeId: "travel" },
    { id: "party", eventTypeId: "birthday" },
  ];
  const event = (eventId: string): ActivityLabel => ({ kind: "event", eventId });
  const type = (eventTypeId: string): ActivityLabel => ({ kind: "eventType", eventTypeId });

  it("adds nothing when no label is picked", () => {
    expect(labelFilterTransactionParams(undefined, events)).toEqual({});
    expect(labelFilterTransactionParams({ include: [], exclude: [] }, events)).toEqual({});
  });

  it("names the included payees", () => {
    const filter = { include: [payee("bakery"), payee("water")] };

    expect(labelFilterTransactionParams(filter, events)).toEqual({ payees: "bakery,water" });
  });

  it("names the included events, an event type being all of its events", () => {
    const filter = { include: [type("travel"), event("party"), event("trip-1")] };

    expect(labelFilterTransactionParams(filter, events)).toEqual({
      events: "trip-1,trip-2,party",
    });
  });

  it("has no equivalent for what the Transactions page cannot narrow by", () => {
    // Left out.
    expect(labelFilterTransactionParams({ exclude: [payee("bakery")] }, events)).toBeNull();
    expect(
      labelFilterTransactionParams(
        { include: [payee("water")], exclude: [type("travel")] },
        events,
      ),
    ).toBeNull();
    // A payee or an event: the page would list a payee and an event.
    expect(
      labelFilterTransactionParams({ include: [payee("bakery"), event("party")] }, events),
    ).toBeNull();
    // A category that is not a payee, and a type with no event to name.
    expect(
      labelFilterTransactionParams(
        { include: [{ kind: "category", taxonomyId: "spending_categories", categoryId: "food" }] },
        events,
      ),
    ).toBeNull();
    expect(labelFilterTransactionParams({ include: [type("wedding")] }, events)).toBeNull();
  });
});

describe("labelFilterRulesOutEvent", () => {
  const trip = { eventId: "trip-1", eventTypeId: "travel" };
  const event = (eventId: string): ActivityLabel => ({ kind: "event", eventId });
  const type = (eventTypeId: string): ActivityLabel => ({ kind: "eventType", eventTypeId });

  it("rules out an event left out by itself or by its type", () => {
    expect(labelFilterRulesOutEvent({ exclude: [type("travel")] }, trip)).toBe(true);
    expect(labelFilterRulesOutEvent({ exclude: [event("trip-1")] }, trip)).toBe(true);
    expect(labelFilterRulesOutEvent({ exclude: [type("birthday"), event("party")] }, trip)).toBe(
      false,
    );
  });

  it("rules out an event that is not among the only events and types kept", () => {
    expect(labelFilterRulesOutEvent({ include: [type("birthday"), event("party")] }, trip)).toBe(
      true,
    );
    expect(labelFilterRulesOutEvent({ include: [type("birthday"), event("trip-1")] }, trip)).toBe(
      false,
    );
    expect(labelFilterRulesOutEvent({ include: [type("travel")] }, trip)).toBe(false);
  });

  it("keeps an event whose activities a payee could still keep", () => {
    // Nothing spent at the bakery on the trip is a low trip, not no trip.
    expect(labelFilterRulesOutEvent({ include: [payee("bakery")] }, trip)).toBe(false);
    expect(labelFilterRulesOutEvent({ include: [payee("bakery"), type("birthday")] }, trip)).toBe(
      false,
    );
    expect(labelFilterRulesOutEvent({ exclude: [payee("bakery")] }, trip)).toBe(false);
    expect(labelFilterRulesOutEvent({}, trip)).toBe(false);
  });

  it("agrees with what the filter keeps of the event's activities", () => {
    const filters: ActivityLabelFilter[] = [
      { exclude: [type("travel")] },
      { include: [type("birthday")] },
      { include: [payee("bakery"), type("birthday")] },
      { include: [type("travel")], exclude: [payee("bakery")] },
    ];
    for (const filter of filters) {
      const keepsSome = [activity("bakery", "trip-1"), activity(null, "trip-1")].some((tagged) =>
        labelFilterKeeps(filter, tagged, typeByEvent),
      );
      // Ruled out means none of its activities can be kept.
      if (labelFilterRulesOutEvent(filter, trip)) expect(keepsSome).toBe(false);
    }
  });
});
