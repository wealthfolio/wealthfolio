/**
 * Money flow — reshapes the reconciled spending insight into a Sankey graph:
 *
 *   income · from savings → total → budget groups · to savings · left over → categories
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
 * Savings show both ways: money brought back from savings is its own source,
 * not netted against what went to savings. Unlike a refund, which cancels a
 * purchase, a withdrawal doesn't undo a contribution — netting them would hide
 * a drawdown behind contributions elsewhere. The headline nets them instead.
 *
 * With no income or money brought back from savings there is nothing to balance
 * against (spending-only setups such as a lone credit card): the total becomes
 * the root and the chart shows where the gross spending went, without refunds
 * or a shortfall.
 *
 * Subcategories stay out of the overview. A category with subcategory activity
 * carries its composition instead, and `focusMoneyFlowGraph` zooms into it.
 */
import type { TaxonomyCategory } from "@/lib/types";

import type { BudgetGroupRow, BudgetSnapshot } from "../types/budget";
import type { CategoryBreakdownRow, MonthlyReport } from "../types/report";
import { DIRECT_ROW_ID, type DrilldownBucket } from "./category-drilldown";
import { ancestorChain, SAVINGS_ROW_COLOR, type RollupMeta } from "./category-rollup";
import { UNCATEGORIZED_CATEGORY_ID } from "./insight-projection";

const SPENDING_TAXONOMY = "spending_categories";

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
  | "from-savings"
  | "refunds"
  | "shortfall"
  | "total"
  | "group"
  | "uncategorized"
  | "saved"
  | "surplus"
  | "category"
  | "savings-category"
  | "more"
  // Only in a zoomed category:
  | "net"
  | "subcategory"
  | "direct";

export interface MoneyFlowMember {
  name: string;
  value: number;
}

/** An immediate subcategory, or what was assigned to the category itself (`DIRECT_ROW_ID`). */
export interface MoneyFlowSubcategory {
  id: string;
  name: string;
  /** Signed: negative when the subcategory's refunds outweigh its spending. */
  value: number;
  color: string;
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
  /** Spending category behind a `category` or `subcategory` node — opens its transactions. */
  categoryId?: string;
  /**
   * Destination node a leaf (or its folded remainder) flows out of; for the
   * folded income remainder, the total it flows into. Zooming into the
   * remainder zooms into this node.
   */
  parentId?: string;
  /** What a `more` node folds, or which categories a `refunds` node nets. */
  members?: MoneyFlowMember[];
  /**
   * A group's (or a zoomed category's) net-refunded categories. They flow in
   * as "Net refunds" rather than out of it, so it reads higher than its net
   * spending.
   */
  netRefunds?: number;
  /**
   * Composition by immediate subcategory, set only when a subcategory has
   * activity: the node then zooms into it rather than ending the flow.
   */
  subcategories?: MoneyFlowSubcategory[];
}

export interface MoneyFlowLink {
  source: string;
  target: string;
  value: number;
}

export interface MoneyFlowTotals {
  income: number;
  /** Money brought back from savings: a source beside income. */
  fromSavings: number;
  /** Size of the total node: money in (with any shortfall) = money out (with any surplus). */
  total: number;
}

export interface MoneyFlowGraph {
  nodes: MoneyFlowNode[];
  links: MoneyFlowLink[];
  totals: MoneyFlowTotals;
  /** A zoomed view's subject: it has nothing more to zoom into. */
  rootId?: string;
}

export interface MoneyFlowLabels {
  total: string;
  shortfall: string;
  refunds: string;
  fromSavings: string;
  saved: string;
  surplus: string;
  uncategorized: string;
  uncategorizedIncome: string;
  more: (count: number) => string;
  direct: string;
  netSpending: string;
  /** Optional display-only resolvers, applied after raw ordering and color selection. */
  category?: (taxonomyId: string, categoryId: string, name: string) => string;
  group?: (groupId: string, name: string) => string;
}

export interface MoneyFlowInput {
  incomeBreakdown: CategoryBreakdownRow[];
  /** Gross money moved to savings, by savings category. */
  savingsBreakdown: CategoryBreakdownRow[];
  /** Gross money brought back from savings; uncategorized, so one figure. */
  fromSavings?: number;
  groupRows: BudgetGroupRow[];
  /** Net uncategorized spending; negative when refunds dominate. */
  uncategorizedSpent: number;
  /** Spending by day and assigned category: where subcategory detail comes from. */
  spendingBuckets: DrilldownBucket[];
  spendingCategories: TaxonomyCategory[];
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
  subcategories?: MoneyFlowSubcategory[];
}

/** The builder's input, read from the page's insight projection. */
export function moneyFlowInputFromReport(
  report: MonthlyReport,
  budget: BudgetSnapshot | undefined,
  categories: {
    spending: TaxonomyCategory[];
    income: TaxonomyCategory[];
    savings: TaxonomyCategory[];
  },
  labels: MoneyFlowLabels,
): MoneyFlowInput {
  return {
    incomeBreakdown: report.incomeBreakdown,
    savingsBreakdown: report.savingsBreakdown,
    fromSavings: report.current.fromSavings ?? 0,
    groupRows: budget?.computed.groupRows ?? [],
    uncategorizedSpent:
      report.spendingBreakdown.find((row) => row.categoryId === UNCATEGORIZED_CATEGORY_ID)
        ?.amount ?? 0,
    spendingBuckets: report.byDayByCategory,
    spendingCategories: categories.spending,
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

  const income = incomeEntries(input.incomeBreakdown, input.incomeCategories, labels);
  const savings = toEntries(input.savingsBreakdown, input.savingsCategories, labels.uncategorized);
  const spendingMeta = new Map(input.spendingCategories.map((category) => [category.id, category]));
  // Unallocated spending belongs to the uncategorized destination, not to a category.
  const spendingDetail = amountsBySubcategory(
    input.spendingBuckets.filter(
      (bucket) =>
        bucket.taxonomyId === SPENDING_TAXONOMY && bucket.categoryId !== UNCATEGORIZED_CATEGORY_ID,
    ),
    spendingMeta,
  );

  const refundMembers: (MoneyFlowMember & { categoryId?: string })[] = [];
  const groups: (Entry & { categories: Entry[]; netRefunds: number })[] = [];
  for (const row of input.groupRows) {
    const groupColor = row.group.color || row.categories.find((c) => c.color)?.color;
    const categories: Entry[] = [];
    let netRefunds = 0;
    for (const c of row.categories) {
      if (c.actual > EPSILON) {
        const color = c.color || groupColor || FALLBACK_COLOR;
        categories.push({
          id: c.categoryId,
          name: c.name,
          value: c.actual,
          color,
          subcategories: subcategoryEntries(
            spendingDetail.get(c.categoryId),
            spendingMeta,
            color,
            labels.direct,
          ),
        });
      } else if (c.actual < -EPSILON) {
        refundMembers.push({ categoryId: c.categoryId, name: c.name, value: -c.actual });
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

  // These entries are newly built presentation data, never query/cache records.
  // Resolve names only after sorting so language changes cannot reorder equal flows.
  const localizeEntries = (taxonomyId: string, entries: Entry[]) => {
    for (const entry of entries) {
      entry.name = labels.category?.(taxonomyId, entry.id, entry.name) ?? entry.name;
      for (const child of entry.subcategories ?? []) {
        if (child.id !== DIRECT_ROW_ID) {
          child.name = labels.category?.(taxonomyId, child.id, child.name) ?? child.name;
        }
      }
    }
  };
  localizeEntries("income_sources", income);
  localizeEntries("savings_categories", savings);
  for (const group of groups) {
    group.name = labels.group?.(group.id, group.name) ?? group.name;
    localizeEntries(SPENDING_TAXONOMY, group.categories);
  }
  const uncategorized = input.uncategorizedSpent > EPSILON ? input.uncategorizedSpent : 0;

  const incomeTotal = sum(income);
  const { fromSavings: broughtBack = 0 } = input;
  const fromSavings = broughtBack > EPSILON ? broughtBack : 0;
  const hasSources = incomeTotal + fromSavings > EPSILON;
  const refunds = hasSources ? sum(refundMembers) : 0;
  const saved = sum(savings);
  const outflow = sum(groups) + uncategorized + saved;
  const inflow = incomeTotal + fromSavings + refunds;
  if (inflow <= EPSILON && outflow <= EPSILON) {
    return { nodes: [], links: [], totals: { income: 0, fromSavings: 0, total: 0 } };
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
      nodes.push({
        ...moreNode("income:more", folded, labels, FALLBACK_COLOR, 0),
        parentId: totalNode.id,
      });
    }
    if (fromSavings > 0) {
      nodes.push({
        id: "from-savings",
        kind: "from-savings",
        name: labels.fromSavings,
        value: fromSavings,
        color: SAVINGS_ROW_COLOR,
        column: 0,
      });
    }
    if (refunds > EPSILON) {
      nodes.push({
        id: "refunds",
        kind: "refunds",
        name: labels.refunds,
        value: refunds,
        color: REFUNDS_COLOR,
        column: 0,
        members: refundMembers.map(({ categoryId, name, value }) => ({
          name: categoryId
            ? (labels.category?.(SPENDING_TAXONOMY, categoryId, name) ?? name)
            : name,
          value,
        })),
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

  return { nodes, links, totals: { income: incomeTotal, fromSavings, total } };
}

/**
 * Zoom into one node. A destination sits on the left with every one of its
 * leaves on the right: pass a graph built without folding so nothing hides
 * behind "+N more". The total shows everything flowing into it, so income
 * folded into "+N more" stays reachable. A category with subcategories shows
 * them flowing the way the category does: out of a spending category, into an
 * income one.
 */
export function focusMoneyFlowGraph(
  graph: MoneyFlowGraph,
  parentId: string,
  labels: MoneyFlowLabels,
): MoneyFlowGraph {
  const parent = graph.nodes.find((node) => node.id === parentId);
  // Gone, or nothing left to show (a refetch moved a zoomed category's activity onto itself).
  if (!parent || (parent.kind !== "total" && !isFocusable(parent))) {
    return { nodes: [], links: [], totals: graph.totals };
  }
  if (parent.kind === "total") return focusMoneyIn(graph, parent);
  if (parent.subcategories) {
    return parent.kind === "income"
      ? focusIncomeCategory(parent, graph.totals)
      : focusSpendingCategory(parent, graph.totals, labels);
  }
  const leaves = graph.nodes.filter((node) => node.parentId === parentId);
  return {
    nodes: [{ ...parent, column: 0 }, ...leaves.map((leaf) => ({ ...leaf, column: 1 }))],
    links: graph.links.filter((link) => link.source === parentId),
    totals: graph.totals,
    rootId: parentId,
  };
}

/** Nodes with more to show: a destination's leaves or a category's subcategories. */
export function isFocusable(node: MoneyFlowNode): boolean {
  return (
    node.kind === "group" ||
    node.kind === "saved" ||
    (node.kind === "more" && !!node.parentId) ||
    !!node.subcategories
  );
}

/** Everything flowing into the total: income, money from savings, net refunds, any shortfall. */
function focusMoneyIn(graph: MoneyFlowGraph, total: MoneyFlowNode): MoneyFlowGraph {
  const links = graph.links.filter((link) => link.target === total.id);
  const sources = graph.nodes.filter((node) => links.some((link) => link.source === node.id));
  // Without income or money from savings the total is the root: nothing flows in.
  if (sources.length === 0) return { nodes: [], links: [], totals: graph.totals };
  return {
    nodes: [...sources.map((source) => ({ ...source, column: 0 })), { ...total, column: 1 }],
    links,
    totals: graph.totals,
    rootId: total.id,
  };
}

/**
 * A spending category fanned out into its subcategories and direct spending.
 * A subcategory whose refunds outweigh its spending can't flow out, so, as in
 * the overview, it flows in as "Net refunds" beside the category's net
 * spending: the category then stands at its gross spending and every node
 * still balances.
 */
function focusSpendingCategory(
  parent: MoneyFlowNode,
  totals: MoneyFlowTotals,
  labels: MoneyFlowLabels,
): MoneyFlowGraph {
  const subcategories = parent.subcategories ?? [];
  const spent = subcategories.filter((entry) => entry.value > EPSILON);
  const refundMembers = subcategories
    .filter((entry) => entry.value < -EPSILON)
    .map((entry) => ({ name: entry.name, value: -entry.value }))
    // Equal amounts retain the builder's raw-name order, not translated-name order.
    .sort((a, b) => b.value - a.value);
  const gross = sum(spent);
  const refunds = sum(refundMembers);
  const rootColumn = refunds > EPSILON ? 1 : 0;

  const nodes: MoneyFlowNode[] = [];
  const links: MoneyFlowLink[] = [];
  if (rootColumn === 1) {
    nodes.push(
      {
        id: `${parent.id}:net`,
        kind: "net",
        name: labels.netSpending,
        value: gross - refunds,
        color: parent.color,
        column: 0,
      },
      {
        id: `${parent.id}:refunds`,
        kind: "refunds",
        name: labels.refunds,
        value: refunds,
        color: REFUNDS_COLOR,
        column: 0,
        members: refundMembers,
      },
    );
    for (const source of nodes) {
      links.push({ source: source.id, target: parent.id, value: source.value });
    }
  }
  nodes.push({
    ...parent,
    value: gross,
    column: rootColumn,
    parentId: undefined,
    subcategories: undefined,
    netRefunds: rootColumn === 1 ? refunds : undefined,
  });
  for (const entry of spent) {
    const leaf: MoneyFlowNode =
      entry.id === DIRECT_ROW_ID
        ? { ...entry, id: `${parent.id}:direct`, kind: "direct", column: rootColumn + 1 }
        : {
            ...entry,
            id: `subcategory:${entry.id}`,
            kind: "subcategory",
            column: rootColumn + 1,
            categoryId: entry.id,
          };
    nodes.push({ ...leaf, parentId: parent.id });
    links.push({ source: parent.id, target: leaf.id, value: leaf.value });
  }
  return { nodes, links, totals, rootId: parent.id };
}

/** An income category gathered from its subcategories and direct income. */
function focusIncomeCategory(parent: MoneyFlowNode, totals: MoneyFlowTotals): MoneyFlowGraph {
  const sources: MoneyFlowNode[] = (parent.subcategories ?? [])
    .filter((entry) => entry.value > EPSILON)
    .map((entry) =>
      entry.id === DIRECT_ROW_ID
        ? { ...entry, id: `${parent.id}:direct`, kind: "direct", column: 0 }
        : { ...entry, id: `income-subcategory:${entry.id}`, kind: "subcategory", column: 0 },
    );
  return {
    nodes: [...sources, { ...parent, value: sum(sources), column: 1, subcategories: undefined }],
    links: sources.map((source) => ({ source: source.id, target: parent.id, value: source.value })),
    totals,
    rootId: parent.id,
  };
}

/**
 * Income rolls up to its top-level category ("Employment"), as spending
 * does, and keeps the assigned subcategories ("Salary", "Bonus") to zoom
 * into. Only rows the chart draws are summed, so the income total is the same
 * either way.
 */
function incomeEntries(
  rows: CategoryBreakdownRow[],
  categories: TaxonomyCategory[],
  labels: MoneyFlowLabels,
): Entry[] {
  const meta = new Map(categories.map((category) => [category.id, category]));
  const entries: Entry[] = [];
  const byTop = amountsBySubcategory(
    rows.filter((row) => row.amount > EPSILON),
    meta,
  );
  for (const [id, byChild] of byTop) {
    const isUncategorized = id === UNCATEGORIZED_CATEGORY_ID;
    const category = meta.get(id);
    const color = isUncategorized ? UNCATEGORIZED_COLOR : category?.color || FALLBACK_COLOR;
    entries.push({
      id,
      name: isUncategorized ? labels.uncategorizedIncome : (category?.name ?? id),
      value: Array.from(byChild.values()).reduce((total, amount) => total + amount, 0),
      color,
      subcategories: subcategoryEntries(byChild, meta, color, labels.direct),
    });
  }
  return entries.sort(byValueDesc);
}

/**
 * Sum rows by top-level category, split by the top's immediate child, or by
 * `DIRECT_ROW_ID` for rows assigned to the top itself (a grandchild counts
 * toward its child). Signed: refunds net against their own subcategory only.
 */
function amountsBySubcategory(
  rows: { categoryId: string; amount: number }[],
  meta: Map<string, RollupMeta>,
): Map<string, Map<string, number>> {
  const out = new Map<string, Map<string, number>>();
  for (const { categoryId, amount } of rows) {
    const chain = ancestorChain(categoryId, meta);
    const top = chain[chain.length - 1];
    const child = chain.length > 1 ? chain[chain.length - 2] : DIRECT_ROW_ID;
    const byChild = out.get(top) ?? new Map<string, number>();
    byChild.set(child, (byChild.get(child) ?? 0) + amount);
    out.set(top, byChild);
  }
  return out;
}

/**
 * A category's composition, largest first, or `undefined` when no subcategory
 * has activity: everything was assigned to the category itself, so there is
 * nothing to zoom into.
 */
function subcategoryEntries(
  byChild: Map<string, number> | undefined,
  meta: Map<string, TaxonomyCategory>,
  parentColor: string,
  directLabel: string,
): MoneyFlowSubcategory[] | undefined {
  const entries: MoneyFlowSubcategory[] = [];
  for (const [id, value] of byChild ?? []) {
    if (Math.abs(value) <= EPSILON) continue;
    const category = id === DIRECT_ROW_ID ? undefined : meta.get(id);
    entries.push({
      id,
      name: id === DIRECT_ROW_ID ? directLabel : (category?.name ?? id),
      value,
      color: category?.color || parentColor,
    });
  }
  return entries.some((entry) => entry.id !== DIRECT_ROW_ID)
    ? entries.sort(byValueDesc)
    : undefined;
}

/**
 * Savings keep the category each activity was assigned ("Retirement"): a lone
 * root such as "Savings" would only repeat its "To savings" parent.
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
