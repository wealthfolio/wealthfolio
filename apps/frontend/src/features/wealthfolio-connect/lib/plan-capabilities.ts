import type { UserInfo } from "../types";

export function isSubscriptionStatusActive(status: string | null | undefined): boolean {
  return status === "active" || status === "trialing" || status === "past_due";
}

export function hasBrokerSync(userInfo: UserInfo | null): boolean {
  const team = userInfo?.team;
  if (!team) return false;
  if (!isSubscriptionStatusActive(team.subscription_status)) return false;
  if (!team.plan) return false;
  return team.plan !== "basic";
}
