import type { ActivityType } from "@/lib/constants";
import type { AccountScope } from "@/lib/types";
import type { ActivityStatusFilter } from "../hooks/use-activity-search";

interface ActivityUrlFilters {
  accountScope?: AccountScope;
  statusFilter?: ActivityStatusFilter;
  activityTypes?: ActivityType[];
  dateFrom?: string;
  dateTo?: string;
  searchQuery?: string;
  /** A single activity id to focus on (e.g. from a health-check deep-link). */
  activityId?: string;
  /** Identifies Health Center deep-links so the destination can show context copy. */
  healthContext?: string;
}

export type ActivityTab = "investments" | "spending";

export function resolveActivityUrlFilters(searchParams: URLSearchParams): ActivityUrlFilters {
  const accountId = searchParams.get("account")?.trim();
  const needsReview = searchParams.get("needsReview") === "true";
  const typesRaw = searchParams.get("types")?.trim();
  const dateFrom = searchParams.get("from")?.trim();
  const dateTo = searchParams.get("to")?.trim();
  const searchQuery = searchParams.get("q")?.trim();
  const activityId = searchParams.get("activity")?.trim();
  const healthContext = searchParams.get("healthContext")?.trim();

  const activityTypes = typesRaw
    ? (typesRaw
        .split(",")
        .map((type) => type.trim())
        .filter(Boolean) as ActivityType[])
    : undefined;

  return {
    ...(accountId ? { accountScope: { type: "account" as const, accountId } } : {}),
    ...(needsReview ? { statusFilter: "pending" as const } : {}),
    ...(activityTypes && activityTypes.length > 0 ? { activityTypes } : {}),
    ...(dateFrom ? { dateFrom } : {}),
    ...(dateTo ? { dateTo } : {}),
    ...(searchQuery ? { searchQuery } : {}),
    ...(activityId ? { activityId } : {}),
    ...(healthContext ? { healthContext } : {}),
  };
}

export function resolveActivityTabFromUrlFilters(
  searchParams: URLSearchParams,
  spendingAccountIds: readonly string[],
): ActivityTab | undefined {
  const accountId = searchParams.get("account")?.trim();
  if (!accountId) return undefined;
  return spendingAccountIds.includes(accountId) ? "spending" : "investments";
}

export function clearActivityUrlFilters(searchParams: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(searchParams);
  next.delete("account");
  next.delete("needsReview");
  next.delete("types");
  next.delete("from");
  next.delete("to");
  next.delete("q");
  next.delete("activity");
  next.delete("healthContext");
  return next;
}

export function clearActivityUrlDateFilters(searchParams: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(searchParams);
  next.delete("from");
  next.delete("to");
  return next;
}

export function clearActivityUrlTypeFilters(searchParams: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(searchParams);
  next.delete("types");
  return next;
}

export function clearActivityUrlSearchFilter(searchParams: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(searchParams);
  next.delete("q");
  return next;
}
