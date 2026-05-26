/** Build a spending-transactions URL with category/subcategory + date filters as query params. */
export function buildCashflowUrl(opts: {
  categoryId?: string | null;
  subcategoryId?: string | null;
  startDate?: string;
  endDate?: string;
}): string {
  const params = new URLSearchParams();
  params.set("tab", "spending");
  if (opts.categoryId) params.set("category", opts.categoryId);
  if (opts.subcategoryId) params.set("subcategory", opts.subcategoryId);
  if (opts.startDate) params.set("from", opts.startDate);
  if (opts.endDate) params.set("to", opts.endDate);
  return `/activities?${params.toString()}`;
}
