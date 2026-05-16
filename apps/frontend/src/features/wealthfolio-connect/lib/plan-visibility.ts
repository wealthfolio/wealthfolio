import type { SubscriptionPlan } from "../types";

export function getDisplayablePlans(plans: SubscriptionPlan[] | undefined): SubscriptionPlan[] {
  return (plans ?? []).filter((plan) => plan.isAvailable || plan.isComingSoon);
}
