import type { FormattingApi } from "@wealthfolio/ui";
import type { TFunction } from "i18next";

import type { EngineActivityIssue, FixAction, HealthIssue, NavigateAction } from "@/lib/types";

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
    "/activities/transfers": "activity:transfer_review.title",
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
      history: "update_value",
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

const ACTIVITY_REASON_KEYS: Record<string, string> = {
  MISSING_FX_RATE: "missing_fx_rate",
  CLOSE_BUY_WITHOUT_SHORT_POSITION: "close_buy_without_short_position",
  SELL_SHORT_INTENT_REQUIRED: "sell_short_intent_required",
  CONVERSION_INSUFFICIENT_HOLDINGS: "conversion_insufficient_holdings",
  CONVERSION_CURRENCY_MISMATCH: "conversion_currency_mismatch",
  RETURN_OF_CAPITAL_AMOUNT_REQUIRED: "return_of_capital_amount_required",
  SELL_WITHOUT_POSITION: "sell_without_position",
  INSUFFICIENT_QUANTITY: "insufficient_quantity",
  MISSING_FINAL_CASH: "missing_final_cash",
};

/** Localize domain reasons at display time; old and unknown reasons keep their message. */
export function translateActivityReason(
  t: TFunction,
  issue: EngineActivityIssue,
  formatting: Pick<FormattingApi, "formatDate" | "formatQuantity">,
): string {
  const reason = issue.reason;
  const key =
    reason && Object.hasOwn(ACTIVITY_REASON_KEYS, reason.code)
      ? ACTIVITY_REASON_KEYS[reason.code]
      : undefined;
  if (!key) return issue.message;

  const params = { ...reason?.params };
  if (params.date) {
    params.date = formatting.formatDate(new Date(`${params.date}T00:00:00Z`), {
      month: "short",
      day: "numeric",
      year: "numeric",
      timeZone: "UTC",
    });
  }
  for (const name of ["requested", "held", "excess"]) {
    if (params[name] != null) params[name] = formatting.formatQuantity(params[name]);
  }
  return t(`health:activityReasons.${key}`, { ...params, defaultValue: issue.message });
}
