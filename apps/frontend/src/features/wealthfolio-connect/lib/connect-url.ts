import { WEALTHFOLIO_CONNECT_PORTAL_URL } from "@/lib/constants";

export type ConnectLinkPlacement = "app_onboarding" | "connect_empty_state" | "subscription_plans";

export function buildConnectUrl(
  runtime: { isWeb: boolean; isMobile?: boolean },
  placement: ConnectLinkPlacement,
  plan?: string,
): string {
  const url = new URL(plan ? "/onboarding" : "/", WEALTHFOLIO_CONNECT_PORTAL_URL);
  url.searchParams.set(
    "source",
    runtime.isWeb
      ? "self_hosted"
      : runtime.isMobile === undefined
        ? "unknown"
        : runtime.isMobile
          ? "mobile_app"
          : "desktop_app",
  );
  url.searchParams.set("placement", placement);
  if (plan) url.searchParams.set("plan", plan);
  return url.toString();
}
