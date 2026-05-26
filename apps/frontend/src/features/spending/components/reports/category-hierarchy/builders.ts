/**
 * Tree + group builders for the spending category-hierarchy table.
 *
 * Pulled out of category-hierarchy-table.tsx so the orchestrator stays focused
 * on render / state and these pure transforms become unit-testable.
 */
import type { TaxonomyCategory } from "@/lib/types";

import type { BudgetCategoryRow, BudgetGroupRow } from "../../../types/budget";
import type { CategoryBreakdownRow } from "../../../types/report";

export type CategorySort = "spent" | "delta" | "name";

export interface NodeRow {
  id: string;
  name: string;
  color: string | null;
  icon: string | null;
  parentId: string | null;
  /** Spent in current period. */
  spent: number;
  /** Spent in prior period. */
  priorSpent: number;
  /** Budgeted (top-level only). */
  budgeted: number;
  /** Children flat list. */
  children: NodeRow[];
}

export interface GroupNode {
  id: string;
  name: string;
  color: string | null;
  icon: string | null;
  spent: number;
  priorSpent: number;
  budgeted: number;
  children: NodeRow[];
}

const OTHER_GROUP_ID = "__other__";

export function buildTree({
  breakdown,
  priorBreakdown,
  budgetRows,
  taxonomyCategories,
  sort,
}: {
  breakdown: CategoryBreakdownRow[];
  priorBreakdown: CategoryBreakdownRow[];
  budgetRows: BudgetCategoryRow[];
  taxonomyCategories: TaxonomyCategory[];
  sort: CategorySort;
}): NodeRow[] {
  const meta = new Map(taxonomyCategories.map((c) => [c.id, c]));
  const allocationByCat = new Map(budgetRows.map((a) => [a.categoryId, a.target || 0]));

  // Build a row per taxonomy category that has *any* signal (spend, prior spend, or budget).
  const nodes = new Map<string, NodeRow>();
  const ensureNode = (id: string): NodeRow => {
    let n = nodes.get(id);
    if (!n) {
      const m = meta.get(id);
      n = {
        id,
        name: m?.name ?? id,
        color: m?.color ?? null,
        icon: m?.icon ?? null,
        parentId: m?.parentId ?? null,
        spent: 0,
        priorSpent: 0,
        budgeted: allocationByCat.get(id) ?? 0,
        children: [],
      };
      nodes.set(id, n);
    }
    return n;
  };

  for (const r of breakdown) ensureNode(r.categoryId).spent += r.amount;
  for (const r of priorBreakdown) ensureNode(r.categoryId).priorSpent += r.amount;
  // Only ensure nodes for allocations that target a spending-taxonomy category;
  // budget allocations pointing at income/other taxonomies must not appear here.
  for (const id of allocationByCat.keys()) {
    if (meta.has(id)) ensureNode(id);
  }

  // Roll subcategory amounts up to top-level parent for the parent row totals.
  // This keeps parent.spent = direct + children spend, matching the visual mental model.
  const rolledUp = new Map<string, NodeRow>();
  const ensureRolled = (id: string): NodeRow => {
    let n = rolledUp.get(id);
    if (!n) {
      const base = nodes.get(id);
      const m = meta.get(id);
      n = {
        id,
        name: base?.name ?? m?.name ?? id,
        color: base?.color ?? m?.color ?? null,
        icon: base?.icon ?? m?.icon ?? null,
        parentId: null,
        spent: base?.spent ?? 0,
        priorSpent: base?.priorSpent ?? 0,
        budgeted: base?.budgeted ?? 0,
        children: [],
      };
      rolledUp.set(id, n);
    }
    return n;
  };
  for (const node of nodes.values()) {
    if (node.parentId == null) {
      ensureRolled(node.id);
    } else {
      const parent = ensureRolled(node.parentId);
      parent.spent += node.spent;
      parent.priorSpent += node.priorSpent;
      if (node.spent > 0 || node.priorSpent > 0 || node.budgeted > 0) {
        parent.children.push({
          ...node,
          spent: Math.max(0, node.spent),
          priorSpent: Math.max(0, node.priorSpent),
          children: [],
        });
      }
    }
  }

  for (const node of rolledUp.values()) {
    node.spent = Math.max(0, node.spent);
    node.priorSpent = Math.max(0, node.priorSpent);
  }

  const compare =
    sort === "name"
      ? (a: NodeRow, b: NodeRow) => a.name.localeCompare(b.name)
      : sort === "delta"
        ? (a: NodeRow, b: NodeRow) =>
            Math.abs(b.spent - b.priorSpent) - Math.abs(a.spent - a.priorSpent)
        : (a: NodeRow, b: NodeRow) => b.spent - a.spent;

  return Array.from(rolledUp.values())
    .filter((n) => n.spent > 0 || n.priorSpent > 0 || n.budgeted > 0)
    .sort(compare);
}

export function buildGroupNodes({
  tree,
  groupRows,
  budgetRows,
}: {
  tree: NodeRow[];
  groupRows: BudgetGroupRow[];
  budgetRows: BudgetCategoryRow[];
}): GroupNode[] {
  // categoryId → groupId, drawn from the per-category budget rows so group
  // assignments stay in sync with what the budget settings page shows.
  const groupByCategory = new Map<string, string>();
  for (const row of budgetRows) {
    if (row.groupId) groupByCategory.set(row.categoryId, row.groupId);
  }

  // Initialize each declared group (preserves the user's sortOrder via groupRows order).
  const buckets = new Map<string, GroupNode>();
  for (const g of groupRows) {
    buckets.set(g.group.id, {
      id: g.group.id,
      name: g.group.name,
      color: g.group.color,
      icon: g.group.icon,
      spent: 0,
      priorSpent: 0,
      budgeted: 0,
      children: [],
    });
  }

  // Backend seeds an "Other" system group (key="other"); reuse it for the
  // catch-all so unassigned categories don't surface a duplicate row.
  const fallbackGroupId =
    groupRows.find((g) => g.group.key === "other")?.group.id ??
    groupRows.find((g) => g.group.name.toLowerCase() === "other")?.group.id;

  const ensureOtherBucket = (): GroupNode => {
    const targetId = fallbackGroupId ?? OTHER_GROUP_ID;
    let b = buckets.get(targetId);
    if (!b) {
      b = {
        id: targetId,
        name: "Other",
        color: null,
        icon: null,
        spent: 0,
        priorSpent: 0,
        budgeted: 0,
        children: [],
      };
      buckets.set(targetId, b);
    }
    return b;
  };

  // Assign each top-level category to its group; categories without a group
  // assignment fall into the "Other" bucket (reusing the real group when present).
  for (const node of tree) {
    const gid = groupByCategory.get(node.id);
    const bucket = (gid ? buckets.get(gid) : undefined) ?? ensureOtherBucket();
    bucket.spent += node.spent;
    bucket.priorSpent += node.priorSpent;
    bucket.budgeted += node.budgeted;
    bucket.children.push(node);
  }

  // Always keep declared groups — even at 0 — so users can confirm a group
  // exists but received no spend (e.g. an empty "Savings" bucket). Only the
  // synthetic fallback is filtered when nothing landed in it.
  return Array.from(buckets.values()).filter(
    (g) => g.id !== OTHER_GROUP_ID || g.children.length > 0,
  );
}

export function formatDelta(delta: number, baseline: number): string {
  if (delta === 0) return "—";
  // No prior period spend — label as "new" instead of restating current amount.
  if (baseline === 0) return delta > 0 ? "new" : "—";
  const pct = (Math.abs(delta) / baseline) * 100;
  const arrow = delta > 0 ? "↑" : "↓";
  return `${arrow} ${pct.toFixed(0)}%`;
}
