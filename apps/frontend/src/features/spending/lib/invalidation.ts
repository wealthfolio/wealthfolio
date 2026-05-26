import type { QueryClient } from "@tanstack/react-query";

import { QueryKeys } from "@/lib/query-keys";

/**
 * Invalidate every spending-related query when an underlying activity, category
 * assignment, event, rule, or budget change happens.
 *
 * Why centralize: previously each mutation invalidated a different subset
 * (transactions only, transactions+events, etc.), so charts/treemap/budget
 * went stale after categorize/delete/event-edit. One helper keeps the set
 * consistent and grep-able.
 */
export function invalidateSpendingCaches(qc: QueryClient, opts: { skip?: readonly string[] } = {}) {
  const skip = new Set(opts.skip ?? []);
  const keys: string[] = [
    QueryKeys.SPENDING_TRANSACTIONS,
    QueryKeys.SPENDING_REPORT,
    QueryKeys.SPENDING_BUDGET,
    QueryKeys.SPENDING_INSIGHT,
    QueryKeys.SPENDING_EVENTS,
  ];
  for (const key of keys) {
    if (skip.has(key)) continue;
    qc.invalidateQueries({ queryKey: [key] });
  }
}
