import { SAVINGS_ROW_ID } from "./category-rollup";

/** Build a spending-transactions URL with category/subcategory + date filters as query params. */
export function buildCashflowUrl(opts: {
  categoryId?: string | null;
  subcategoryId?: string | null;
  status?: string;
  startDate?: string;
  endDate?: string;
}): string {
  const params = new URLSearchParams();
  params.set("tab", "spending");
  if (opts.categoryId) params.set("category", opts.categoryId);
  if (opts.subcategoryId) params.set("subcategory", opts.subcategoryId);
  if (opts.status) params.set("status", opts.status);
  if (opts.startDate) params.set("from", opts.startDate);
  if (opts.endDate) params.set("to", opts.endDate);
  return `/activities?${params.toString()}`;
}

/**
 * Deep-link for a "Where it went" node. The synthetic uncategorized bucket has
 * no real category id, so it routes to the status filter — the category filter
 * would match nothing and render an empty list. The savings row links to the
 * insights cashflow view, which carries its own period params, so `startDate`/
 * `endDate` (ISO YYYY-MM-DD) only apply to the /activities branches.
 */
export function spendingActivityHref(
  id: string,
  opts: { savingsHref?: string; startDate?: string; endDate?: string } = {},
): string {
  const { savingsHref, startDate, endDate } = opts;
  if (id === SAVINGS_ROW_ID) return savingsHref ?? buildCashflowUrl({});
  return id === "__uncategorized__"
    ? buildCashflowUrl({ status: "uncategorized", startDate, endDate })
    : buildCashflowUrl({ categoryId: id, startDate, endDate });
}
