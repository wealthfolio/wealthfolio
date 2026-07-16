/**
 * Shared category rollup helpers — single source of truth used by the
 * dashboard tab, insights stages, budget chart, and any other widget that
 * needs to roll subcategory amounts up to their top-level parent.
 *
 * Background: this logic was duplicated across five files
 * (`spending-tab-content`, `where-i-am-stage` ×2, `what-changed-stage` ×3,
 * `budget-line-chart-card`) — each with subtly different fallback behavior
 * for missing meta and no guard against cyclic `parentId`. Centralizing here
 * eliminates the drift surface called out in the comprehensive review.
 */

/** Minimal shape needed for rollup — accepts `TaxonomyCategory` or any
 *  `{ id, parentId }` value carried in a `Map`. */
export interface RollupMeta {
  parentId?: string | null;
}

/** Maximum chain depth to walk. Real taxonomies are 2 levels (top + sub);
 *  the cap guards against a corrupted meta map with cyclic parent_id chains. */
const MAX_PARENT_DEPTH = 32;

/**
 * Walk a category's parent chain to return the top-level (root) category id.
 * For a top-level category, returns the id unchanged. If `meta` doesn't
 * contain the category, returns the original id (treat-as-top fallback —
 * matches the prior ad-hoc behavior of `c?.parentId ?? r.categoryId`).
 *
 * Bounded depth: a cyclic chain is detected via a seen-set and returns the
 * current node rather than looping forever.
 */
export function topCategoryId(categoryId: string, meta: Map<string, RollupMeta>): string {
  let current = categoryId;
  const seen = new Set<string>();
  seen.add(current);
  for (let i = 0; i < MAX_PARENT_DEPTH; i++) {
    const c = meta.get(current);
    if (!c?.parentId) return current;
    if (seen.has(c.parentId)) return current;
    seen.add(c.parentId);
    current = c.parentId;
  }
  return current;
}

/**
 * Sum a list of `{ categoryId, amount }` rows by their top-level parent.
 * Returns a `Map<topId, total>` with rows whose total is `<= 0` filtered out
 * (matches the prior `where-i-am-stage` behavior; the no-budget case).
 *
 * Use `rollUpAmountsWithCount` instead if you also need the count of rows
 * contributing to each top.
 */
export function rollUpToTopLevel<T extends { categoryId: string; amount: number }>(
  rows: T[],
  meta: Map<string, RollupMeta>,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of rows) {
    const top = topCategoryId(r.categoryId, meta);
    out.set(top, (out.get(top) ?? 0) + r.amount);
  }
  for (const [id, amount] of out) {
    if (amount <= 0) out.delete(id);
  }
  return out;
}

/**
 * Same as `rollUpToTopLevel`, but also accumulates a `count` per top. Useful
 * when rows carry transaction counts (e.g. `CategoryBreakdownRow`).
 * Unlike `rollUpToTopLevel`, this variant keeps zero-amount tops — callers
 * doing union-by-key need the entry present even if the magnitude is 0.
 */
export function rollUpAmountsWithCount<
  T extends { categoryId: string; amount: number; count?: number },
>(rows: T[], meta: Map<string, RollupMeta>): Map<string, { amount: number; count: number }> {
  const out = new Map<string, { amount: number; count: number }>();
  for (const r of rows) {
    const top = topCategoryId(r.categoryId, meta);
    const e = out.get(top) ?? { amount: 0, count: 0 };
    e.amount += r.amount;
    e.count += r.count ?? 0;
    out.set(top, e);
  }
  return out;
}

/**
 * Set of distinct top-level category ids referenced by a list of rows.
 * Useful when building a union of "tops with current data" + "tops with
 * prior data" for delta tables.
 */
export function distinctTopIds<T extends { categoryId: string }>(
  rows: T[],
  meta: Map<string, RollupMeta>,
): Set<string> {
  const out = new Set<string>();
  for (const r of rows) out.add(topCategoryId(r.categoryId, meta));
  return out;
}

/** Synthetic row id for the "money set aside" entry in the "Where it went"
 *  widget — kept distinct from real category ids. */
export const SAVINGS_ROW_ID = "__savings__";
export const SAVINGS_ROW_COLOR = "#6B8E54";

export interface CategoryMeta {
  name: string;
  color: string | null;
  icon: string | null;
  parentId: string | null;
}

export interface WhereItWentRow {
  id: string;
  name: string;
  color: string | null;
  icon: string | null;
  amount: number;
  subCount: number;
  txCount: number;
  delta: number;
  deltaPct: number | null;
}

/**
 * Roll spending categories up to their top-level parent for the "Where it
 * went" widget (map/list), and — when money was saved this period — append
 * a distinct "Saving" row so it isn't invisible next to where money was
 * spent. Otherwise savings only showed up on the "view all" insights page,
 * which read as if nothing had been saved.
 */
export function buildWhereItWentRows(params: {
  spendingBreakdown: { categoryId: string; amount: number; count: number }[];
  priorSpendingBreakdown: { categoryId: string; amount: number }[];
  categoriesMeta: Map<string, CategoryMeta>;
  totalSaved: number;
  priorSaved: number;
  uncategorizedLabel: string;
  savingsLabel: string;
}): WhereItWentRow[] {
  const {
    spendingBreakdown,
    priorSpendingBreakdown,
    categoriesMeta,
    totalSaved,
    priorSaved,
    uncategorizedLabel,
    savingsLabel,
  } = params;

  const topAmounts = new Map<string, { amount: number; subCount: number; txCount: number }>();
  for (const row of spendingBreakdown) {
    const meta = categoriesMeta.get(row.categoryId);
    const topId = topCategoryId(row.categoryId, categoriesMeta);
    const e = topAmounts.get(topId) ?? { amount: 0, subCount: 0, txCount: 0 };
    e.amount += row.amount;
    e.txCount += row.count;
    if (meta?.parentId) e.subCount += 1;
    topAmounts.set(topId, e);
  }

  const priorAmounts = new Map<string, number>();
  for (const row of priorSpendingBreakdown) {
    const topId = topCategoryId(row.categoryId, categoriesMeta);
    priorAmounts.set(topId, (priorAmounts.get(topId) ?? 0) + row.amount);
  }

  if (totalSaved > 0) {
    topAmounts.set(SAVINGS_ROW_ID, { amount: totalSaved, subCount: 0, txCount: 0 });
    priorAmounts.set(SAVINGS_ROW_ID, priorSaved);
  }

  return Array.from(topAmounts.entries())
    .sort(([, a], [, b]) => b.amount - a.amount)
    .map(([id, e]) => {
      const meta = categoriesMeta.get(id);
      const priorAmt = priorAmounts.get(id) ?? 0;
      const delta = e.amount - priorAmt;
      const deltaPct = priorAmt > 0 ? (delta / priorAmt) * 100 : null;
      return {
        id,
        name:
          id === "__uncategorized__"
            ? uncategorizedLabel
            : id === SAVINGS_ROW_ID
              ? savingsLabel
              : (meta?.name ?? id),
        color: id === SAVINGS_ROW_ID ? SAVINGS_ROW_COLOR : (meta?.color ?? null),
        icon: meta?.icon ?? null,
        amount: e.amount,
        subCount: e.subCount,
        txCount: e.txCount,
        delta,
        deltaPct,
      };
    })
    .filter((row) => row.amount > 0);
}
