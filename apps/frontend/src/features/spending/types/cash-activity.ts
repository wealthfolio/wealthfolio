import type { Activity } from "@/lib/types";

export interface CashActivityFilter {
  accountIds?: string[];
  startDate?: string;
  endDate?: string;
  activityTypes?: string[];
}

export interface ActivityTaxonomyAssignment {
  id: string;
  activityId: string;
  taxonomyId: string;
  categoryId: string;
  weight: number;
  source: string;
  createdAt: string;
  updatedAt: string;
}

export interface ActivitySplit {
  id: string;
  activityId: string;
  taxonomyId: string;
  categoryId: string;
  amount: string | number;
  note?: string | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface NewActivitySplit {
  taxonomyId: string;
  categoryId: string;
  amount: string | number;
  note?: string | null;
  sortOrder?: number | null;
}

export type CashFlowBucket = "spending" | "income" | "saving" | "neutral";
export type TransferLinkStatus = "linked" | "unlinked" | "invalid";

export type CashActivityStatusFilter = "all" | "needs_review" | "uncategorized" | "categorized";

export type CashActivitySortField = "date" | "amount";
export type CashActivitySortDirection = "asc" | "desc";

/** Search request — mirrors `wealthfolio_spending::cash_activities::CashActivitySearchRequest`. */
export interface CashActivitySearchRequest {
  search?: string;
  accountIds?: string[];
  activityTypes?: string[];
  categoryIds?: string[];
  subcategoryIds?: string[];
  eventIds?: string[];
  status?: CashActivityStatusFilter;
  startDate?: string;
  endDate?: string;
  minAmount?: number;
  maxAmount?: number;
  sortBy?: CashActivitySortField;
  sortDir?: CashActivitySortDirection;
  offset?: number;
  limit?: number;
}

/**
 * Canonical cash-activity row. Mirrors
 * `wealthfolio_spending::cash_activities::CashActivity` — the portfolio-wide
 * `Activity` flattened with spending-domain enrichments (single-select
 * assignment + optional event tag). Both `list()` and `search()` return this
 * shape; consumers should always use it instead of bare `Activity` when in
 * the spending feature.
 */
export interface CashActivity extends Activity {
  cashFlowBucket: CashFlowBucket;
  assignments: ActivityTaxonomyAssignment[];
  splits: ActivitySplit[];
  /** Spending event tag from the `activity_events` join. `undefined` when untagged. */
  eventId?: string | null;
  /** Transfer pair validity for effective TRANSFER_IN / TRANSFER_OUT rows. */
  transferLinkStatus?: TransferLinkStatus | null;
}

export interface CashActivitySearchResponse {
  items: CashActivity[];
  totalCount: number;
}
