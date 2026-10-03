import { ActivityStatus } from "@/lib/constants";
import type { ActivityDetails } from "@/lib/types";

/** A withdrawal that could pay this loan: posted, in its currency and not yet linked. */
export function isPaymentCandidate(activity: ActivityDetails, currency: string): boolean {
  return (
    (activity.status === undefined || activity.status === ActivityStatus.POSTED) &&
    activity.currency === currency &&
    !activity.metadata?.loan_payment
  );
}

/** The calendar day a withdrawal counts on: its UTC date, as the engine dates payments. */
export function activityDay(activity: Pick<ActivityDetails, "date">): string {
  return new Date(activity.date).toISOString().slice(0, 10);
}
