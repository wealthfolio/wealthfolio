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
  /**
   * Signed cash movement in this row's own currency — positive when money
   * entered the account, negative when it left, zero when the row moved none.
   * Never converted. Produced by the same resolver that builds account cash
   * balances, so summing these agrees with the account page.
   */
  netAmount: number;
  /**
   * `netAmount` in the base currency, converted at this row's own date.
   * Absent when no conversion was asked for, or this currency has no rate.
   */
  netAmountBase?: number | null;
  /**
   * Signed contribution to spending totals in this row's own currency — the
   * spending-bucket amount with excluded-category portions removed, computed
   * server-side with the same allocator and exclusion index as the reports.
   * Absent only from rows produced by a backend that predates exclusions.
   */
  visibleSpendingAmount?: number;
}

/** A signed net in one currency. */
export interface CurrencyNet {
  currency: string;
  amount: number;
}

/** The net of a set of rows: always per currency, optionally also converted. */
export interface NetSummary {
  /** Uses no exchange rates, so it cannot be wrong. */
  byCurrency: CurrencyNet[];
  /**
   * One figure in the base currency. Absent when a single currency contributes
   * (the breakdown already is the total) or when some currency had no rate, so
   * a converted total would silently omit its rows.
   */
  converted?: CurrencyNet | null;
}

export interface CashActivitySearchResponse {
  items: CashActivity[];
  totalCount: number;
  /**
   * Net over the whole filtered set, summed server-side before pagination so it
   * covers rows this page does not carry. Only the first page has it.
   */
  net?: NetSummary | null;
  /**
   * Currency `netAmountBase` and `net.converted` are denominated in. Reported
   * by the server so a cached response stays correctly labelled even after the
   * base-currency setting changes.
   */
  baseCurrency?: string | null;
}
