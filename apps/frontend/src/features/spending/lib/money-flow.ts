/**
 * Money flow — reshapes the reconciled spending insight into a Sankey graph:
 *
 *   income sources → total → budget groups · set aside · left over → categories
 *
 * Pure projection of figures the backend already reconciles: nothing here
 * re-aggregates activities. A Sankey can only draw non-negative flows, so two
 * synthetic nodes keep every column balanced without dropping money:
 *
 * - a category whose refunds exceed its charges (net negative) becomes a
 *   "Net refunds" inflow instead of a negative outflow;
 * - the gap between money in and money out becomes "Left over" (surplus) or
 *   "Shortfall" (deficit), so the total node always equals both sides and the
 *   surplus equals the headline net cashflow.
 *
 * With no income recorded there is nothing to balance against (spending-only
 * setups such as a lone credit card): the total becomes the root and the chart
 * shows where the gross spending went, without refunds or a shortfall.
 */
import type { TaxonomyCategory } from "@/lib/types";

import type { BudgetGroupRow, BudgetSnapshot } from "../types/budget";
import type { CategoryBreakdownRow, MonthlyReport } from "../types/report";
import { SAVINGS_ROW_COLOR } from "./category-rollup";
import { UNCATEGORIZED_CATEGORY_ID } from "./insight-projection";

/** Amounts under a cent are FX/rounding noise, not flows worth drawing. */
const EPSILON = 0.005;
const DEFAULT_MAX_SOURCES = 5;
const DEFAULT_MAX_CATEGORIES_PER_GROUP = 5;
/** Leaves under this share of the total fold into "+N more" — they'd be hairlines. */
const DEFAULT_MIN_LEAF_SHARE = 0.01;

const FALLBACK_COLOR = "#9C998E";
const UNCATEGORIZED_COLOR = "#9CA3AF";
const TOTAL_COLOR = "var(--muted-foreground)";
const REFUNDS_COLOR = "var(--chart-2)";
const SURPLUS_COLOR = "var(--success)";
const SHORTFALL_COLOR = "var(--destructive)";

export type MoneyFlowNodeKind =
  | "income"
  | "refunds"
  | "shortfall"
  | "total"
  | "group"
  | "uncategorized"
  | "saved"
  | "surplus"
  | "category"
  | "savings-category"
  | "more";

export interface MoneyFlowMember {
  name: string;
  value: number;
}

export interface MoneyFlowNode {
  id: string;
  kind: MoneyFlowNodeKind;
  /** Display name; synthetic nodes take theirs from `MoneyFlowLabels`. */
  name: string;
  value: number;
  color: string;
  /** 0-based column, left to right. */
  column: number;
  /** Spending category behind a `category` node — opens its transactions. */
  categoryId?: string;
  /** Destination node a leaf (or its folded remainder) flows out of. */
  parentId?: string;
  /** What a `more` node folds, or which categories a `refunds` node nets. */
  members?: MoneyFlowMember[];
  /**
   * A group's net-refunded categories. They flow in as "Net refunds" rather
   * than out of the group, so the group reads higher than its net spending.
   */
  netRefunds?: number;
}

export interface MoneyFlowLink {
  source: string;
  target: string;
  value: number;
}

export interface MoneyFlowTotals {
  income: number;
  /** Size of the total node: money in (with any shortfall) = money out (with any surplus). */
  total: number;
}

export interface MoneyFlowGraph {
  nodes: MoneyFlowNode[];
  links: MoneyFlowLink[];
  totals: MoneyFlowTotals;
}

export interface MoneyFlowLabels {
  total: string;
  shortfall: string;
  refunds: string;
  saved: string;
  surplus: string;
  uncategorized: string;
  uncategorizedIncome: string;
  more: (count: number) => string;
}

export interface MoneyFlowInput {
  incomeBreakdown: CategoryBreakdownRow[];
  savingsBreakdown: CategoryBreakdownRow[];
  groupRows: BudgetGroupRow[];
  /** Net uncategorized spending; negative when refunds dominate. */
  uncategorizedSpent: number;
  incomeCategories: TaxonomyCategory[];
  savingsCategories: TaxonomyCategory[];
  labels: MoneyFlowLabels;
}

export interface MoneyFlowOptions {
  /** Draw the category column; narrow screens stop at groups. */
  includeCategories?: boolean;
  maxSources?: number;
  maxCategoriesPerGroup?: number;
  minLeafShare?: number;
}

interface Entry {
  id: string;
  name: string;
  value: number;
  color: string;
}

/** The builder's input, read from the page's insight projection. */
export function moneyFlowInputFromReport(
  report: MonthlyReport,
  budget: BudgetSnapshot | undefined,
  categories: { income: TaxonomyCategory[]; savings: TaxonomyCategory[] },
  labels: MoneyFlowLabels,
): MoneyFlowInput {
  return {
    incomeBreakdown: report.incomeBreakdown,
    savingsBreakdown: report.savingsBreakdown,
    groupRows: budget?.computed.groupRows ?? [],
    uncategorizedSpent:
      report.spendingBreakdown.find((row) => row.categoryId === UNCATEGORIZED_CATEGORY_ID)
        ?.amount ?? 0,
    incomeCategories: categories.income,
    savingsCategories: categories.savings,
    labels,
  };
}

export function buildMoneyFlowGraph(
  input: MoneyFlowInput,
  options: MoneyFlowOptions = {},
): MoneyFlowGraph {
  const {
    includeCategories = true,
    maxSources = DEFAULT_MAX_SOURCES,
    maxCategoriesPerGroup = DEFAULT_MAX_CATEGORIES_PER_GROUP,
    minLeafShare = DEFAULT_MIN_LEAF_SHARE,
  } = options;
  const { labels } = input;

  const income = toEntries(
    input.incomeBreakdown,
    input.incomeCategories,
    labels.uncategorizedIncome,
  );
  const savings = toEntries(input.savingsBreakdown, input.savingsCategories, labels.uncategorized);

  const refundMembers: MoneyFlowMember[] = [];
  const groups: (Entry & { categories: Entry[]; netRefunds: number })[] = [];
  for (const row of input.groupRows) {
    const groupColor = row.group.color || row.categories.find((c) => c.color)?.color;
    const categories: Entry[] = [];
    let netRefunds = 0;
    for (const c of row.categories) {
      if (c.actual > EPSILON) {
        categories.push({
          id: c.categoryId,
          name: c.name,
          value: c.actual,
          color: c.color || groupColor || FALLBACK_COLOR,
        });
      } else if (c.actual < -EPSILON) {
        refundMembers.push({ name: c.name, value: -c.actual });
        netRefunds -= c.actual;
      }
    }
    if (categories.length === 0) continue;
    categories.sort(byValueDesc);
    groups.push({
      id: row.group.id,
      name: row.group.name,
      value: sum(categories),
      color: groupColor || FALLBACK_COLOR,
      categories,
      netRefunds,
    });
  }
  groups.sort(byValueDesc);

  if (input.uncategorizedSpent < -EPSILON) {
    refundMembers.push({ name: labels.uncategorized, value: -input.uncategorizedSpent });
  }
  refundMembers.sort(byValueDesc);
  const uncategorized = input.uncategorizedSpent > EPSILON ? input.uncategorizedSpent : 0;

  const incomeTotal = sum(income);
  const hasSources = incomeTotal > EPSILON;
  const refunds = hasSources ? sum(refundMembers) : 0;
  const saved = sum(savings);
  const outflow = sum(groups) + uncategorized + saved;
  const inflow = incomeTotal + refunds;
  if (inflow <= EPSILON && outflow <= EPSILON) {
    return { nodes: [], links: [], totals: { income: 0, total: 0 } };
  }

  const net = hasSources ? inflow - outflow : 0;
  const surplus = net > EPSILON ? net : 0;
  const shortfall = net < -EPSILON ? -net : 0;
  const total = Math.max(inflow, outflow);
  const totalColumn = hasSources ? 1 : 0;
  const minLeafValue = total * minLeafShare;

  const nodes: MoneyFlowNode[] = [];
  const links: MoneyFlowLink[] = [];
  const totalNode: MoneyFlowNode = {
    id: "total",
    kind: "total",
    name: labels.total,
    value: total,
    color: TOTAL_COLOR,
    column: totalColumn,
  };

  // ── Column 0: where the money came from ──
  if (hasSources) {
    const { kept, folded } = foldEntries(income, maxSources, minLeafValue);
    for (const entry of kept) {
      nodes.push({ ...entry, id: `income:${entry.id}`, kind: "income", column: 0 });
    }
    if (folded.length > 0) {
      nodes.push(moreNode("income:more", folded, labels, FALLBACK_COLOR, 0));
    }
    if (refunds > EPSILON) {
      nodes.push({
        id: "refunds",
        kind: "refunds",
        name: labels.refunds,
        value: refunds,
        color: REFUNDS_COLOR,
        column: 0,
        members: refundMembers,
      });
    }
    if (shortfall > 0) {
      nodes.push({
        id: "shortfall",
        kind: "shortfall",
        name: labels.shortfall,
        value: shortfall,
        color: SHORTFALL_COLOR,
        column: 0,
      });
    }
    for (const source of nodes) {
      links.push({ source: source.id, target: totalNode.id, value: source.value });
    }
  }

  nodes.push(totalNode);

  // ── Destinations: spending groups first, kept money (saved, left over) last ──
  const destinationColumn = totalColumn + 1;
  const destinations: MoneyFlowNode[] = groups.map((group) => ({
    id: `group:${group.id}`,
    kind: "group",
    name: group.name,
    value: group.value,
    color: group.color,
    column: destinationColumn,
    netRefunds: group.netRefunds > EPSILON ? group.netRefunds : undefined,
  }));
  if (uncategorized > 0) {
    destinations.push({
      id: "uncategorized",
      kind: "uncategorized",
      name: labels.uncategorized,
      value: uncategorized,
      color: UNCATEGORIZED_COLOR,
      column: destinationColumn,
    });
  }
  if (saved > EPSILON) {
    destinations.push({
      id: "saved",
      kind: "saved",
      name: labels.saved,
      value: saved,
      color: SAVINGS_ROW_COLOR,
      column: destinationColumn,
    });
  }
  if (surplus > 0) {
    destinations.push({
      id: "surplus",
      kind: "surplus",
      name: labels.surplus,
      value: surplus,
      color: SURPLUS_COLOR,
      column: destinationColumn,
    });
  }
  for (const destination of destinations) {
    nodes.push(destination);
    links.push({ source: totalNode.id, target: destination.id, value: destination.value });
  }

  // ── Leaves: categories, in their destination's order so ribbons never cross ──
  if (includeCategories) {
    const leafColumn = destinationColumn + 1;
    const addLeaves = (
      parentId: string,
      entries: Entry[],
      kind: "category" | "savings-category",
      parentColor: string,
    ) => {
      const { kept, folded } = foldEntries(entries, maxCategoriesPerGroup, minLeafValue);
      const leaves: MoneyFlowNode[] = kept.map((entry) => ({
        ...entry,
        id: `${kind}:${entry.id}`,
        kind,
        column: leafColumn,
        parentId,
        categoryId: kind === "category" ? entry.id : undefined,
      }));
      if (folded.length > 0) {
        leaves.push({
          ...moreNode(`${parentId}:more`, folded, labels, parentColor, leafColumn),
          parentId,
        });
      }
      for (const leaf of leaves) {
        nodes.push(leaf);
        links.push({ source: parentId, target: leaf.id, value: leaf.value });
      }
    };
    for (const group of groups) {
      addLeaves(`group:${group.id}`, group.categories, "category", group.color);
    }
    if (saved > EPSILON) {
      addLeaves("saved", savings, "savings-category", SAVINGS_ROW_COLOR);
    }
  }

  return { nodes, links, totals: { income: incomeTotal, total } };
}

/**
 * Zoom into one destination: the destination on the left, every one of its
 * leaves on the right. Pass a graph built without folding so nothing hides
 * behind "+N more".
 */
export function focusMoneyFlowGraph(graph: MoneyFlowGraph, parentId: string): MoneyFlowGraph {
  const parent = graph.nodes.find((node) => node.id === parentId);
  if (!parent) return { nodes: [], links: [], totals: graph.totals };
  const leaves = graph.nodes.filter((node) => node.parentId === parentId);
  return {
    nodes: [{ ...parent, column: 0 }, ...leaves.map((leaf) => ({ ...leaf, column: 1 }))],
    links: graph.links.filter((link) => link.source === parentId),
    totals: graph.totals,
  };
}

/** Destinations that have leaves to zoom into. */
export function isFocusable(node: MoneyFlowNode): boolean {
  return (
    node.kind === "group" || node.kind === "saved" || (node.kind === "more" && !!node.parentId)
  );
}

/**
 * Income and savings keep the category each activity was assigned ("Salary",
 * "Retirement"): the income side has no group layer to roll up into, and a
 * lone root such as "Savings" would only repeat its "Set aside" parent.
 */
function toEntries(
  rows: CategoryBreakdownRow[],
  categories: TaxonomyCategory[],
  uncategorizedLabel: string,
): Entry[] {
  const meta = new Map(categories.map((category) => [category.id, category]));
  const entries: Entry[] = [];
  for (const { categoryId: id, amount } of rows) {
    if (amount <= EPSILON) continue;
    const isUncategorized = id === UNCATEGORIZED_CATEGORY_ID;
    const category = meta.get(id);
    entries.push({
      id,
      name: isUncategorized ? uncategorizedLabel : (category?.name ?? id),
      value: amount,
      color: isUncategorized ? UNCATEGORIZED_COLOR : category?.color || FALLBACK_COLOR,
    });
  }
  return entries.sort(byValueDesc);
}

/**
 * Keep the largest entries (up to `max`, each at least `minValue`) and fold the
 * rest. The largest always stays named, and a lone leftover stays visible:
 * "+1 more" hides a name to save nothing.
 */
function foldEntries(
  entries: Entry[],
  max: number,
  minValue: number,
): { kept: Entry[]; folded: Entry[] } {
  const kept: Entry[] = [];
  const folded: Entry[] = [];
  for (const entry of entries) {
    if (kept.length === 0 || (kept.length < max && entry.value >= minValue)) kept.push(entry);
    else folded.push(entry);
  }
  if (folded.length === 1) return { kept: [...kept, ...folded], folded: [] };
  return { kept, folded };
}

function moreNode(
  id: string,
  folded: Entry[],
  labels: MoneyFlowLabels,
  color: string,
  column: number,
): MoneyFlowNode {
  return {
    id,
    kind: "more",
    name: labels.more(folded.length),
    value: sum(folded),
    color,
    column,
    members: folded.map(({ name, value }) => ({ name, value })),
  };
}

function sum(items: { value: number }[]): number {
  return items.reduce((total, item) => total + item.value, 0);
}

function byValueDesc(a: { value: number; name: string }, b: { value: number; name: string }) {
  return b.value - a.value || a.name.localeCompare(b.name);
}
