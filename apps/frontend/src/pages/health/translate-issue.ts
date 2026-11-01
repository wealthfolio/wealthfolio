import type { TFunction } from "i18next";

import type { FixAction, HealthIssue, NavigateAction } from "@/lib/types";

// Prefer the translated `health:issues.<code>.<field>` (interpolated with the
// backend's params); fall back to the English title/message the backend still
// sends when an issue has no code yet. This lets checks migrate incrementally.
export function translateIssueText(
  t: TFunction,
  issue: Pick<HealthIssue, "code" | "params" | "title" | "message">,
  field: "title" | "message",
): string {
  const fallback = issue[field];
  if (!issue.code) return fallback;
  return t(`health:issues.${issue.code}.${field}`, {
    ...(issue.params ?? {}),
    defaultValue: fallback,
  });
}

/** Translate built-in action labels without changing their IDs, routes or payloads. */
export function translateHealthAction(t: TFunction, action: FixAction | NavigateAction): string {
  if ("id" in action) {
    return t(`health:actions.${action.id}`, { defaultValue: action.label });
  }
  const routeKeys: Record<string, string> = {
    "/holdings": "activity:import.steps.reviewHoldings",
    "/activities": "activity:import.steps.reviewTransactions",
    "/settings/accounts": "to_accounts",
    "/settings/taxonomies": "to_taxonomies",
    "/settings/market-data": "to_market_data",
    "/settings/general": "to_general_settings",
    "/connect": "to_connect",
  };
  let key = routeKeys[action.route];
  if (action.route === "/activities" && action.query?.activity) {
    key = "review_transaction";
  }
  if (action.route.startsWith("/holdings/") && action.query) {
    const tabKeys: Record<string, string> = {
      quotes: "add_price",
      snapshots: "update_cost_basis",
      activities: "activity:import.steps.reviewTransactions",
    };
    key = tabKeys[String(action.query.tab)];
  }
  if (
    /^\/accounts\/[^/]+$/.test(action.route) &&
    action.query?.tab === "snapshots" &&
    action.query?.healthContext === "invalidSnapshot"
  ) {
    key = "review_entry";
  }
  return key
    ? t(key.includes(":") ? key : `health:actions.${key}`, { defaultValue: action.label })
    : action.label;
}
