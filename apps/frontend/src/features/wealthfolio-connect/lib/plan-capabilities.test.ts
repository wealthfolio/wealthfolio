import { describe, expect, it } from "vitest";
import { hasBrokerSync, isSubscriptionStatusActive } from "./plan-capabilities";
import type { UserInfo } from "../types";

function userInfo(status: string): UserInfo {
  return {
    id: "user-1",
    full_name: null,
    email: null,
    avatar_url: null,
    locale: null,
    week_starts_on_monday: null,
    timezone: null,
    timezone_auto_sync: null,
    time_format: null,
    date_format: null,
    team_id: "team-1",
    team_role: "owner",
    team: {
      id: "team-1",
      name: "Team",
      logo_url: null,
      plan: "essentials",
      subscription_status: status,
      subscription_current_period_end: null,
      subscription_cancel_at_period_end: false,
      canceled_at: null,
      country_code: null,
      created_at: null,
    },
  };
}

describe("subscription capabilities", () => {
  it.each(["active", "trialing", "past_due"] as const)("allows sync for %s", (status) => {
    expect(isSubscriptionStatusActive(status)).toBe(true);
    expect(hasBrokerSync(userInfo(status))).toBe(true);
  });

  it.each(["canceled", "unpaid"] as const)("disables sync for %s", (status) => {
    expect(hasBrokerSync(userInfo(status))).toBe(false);
  });

  it.each([null, undefined, "incomplete", "incomplete_expired", "paused", "unknown"])(
    "disables sync for %s",
    (status) => {
      expect(isSubscriptionStatusActive(status)).toBe(false);
    },
  );
});
