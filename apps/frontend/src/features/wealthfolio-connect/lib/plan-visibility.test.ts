import { describe, expect, it } from "vitest";
import type { SubscriptionPlan } from "../types";
import { getDisplayablePlans } from "./plan-visibility";

function plan(
  id: SubscriptionPlan["id"],
  isAvailable: boolean,
  isComingSoon: boolean,
): SubscriptionPlan {
  return {
    id,
    name: id,
    description: id,
    pricing: { monthly: 0, yearly: 0 },
    limits: { householdSize: 1, institutionConnections: 1, devices: 1 },
    features: [],
    isAvailable,
    isComingSoon,
  };
}

describe("getDisplayablePlans", () => {
  it("uses only API-returned plans and hides unavailable non-coming-soon plans", () => {
    const plans = getDisplayablePlans([
      plan("basic", true, false),
      plan("essentials", true, false),
      plan("duo", false, true),
      plan("plus", false, false),
    ]);

    expect(plans.map((item) => item.id)).toEqual(["basic", "essentials", "duo"]);
  });

  it("does not add Plus when the API omits it", () => {
    const plans = getDisplayablePlans([
      plan("basic", true, false),
      plan("essentials", true, false),
    ]);

    expect(plans.map((item) => item.id)).toEqual(["basic", "essentials"]);
  });
});
