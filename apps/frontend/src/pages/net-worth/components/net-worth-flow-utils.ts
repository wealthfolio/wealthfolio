import { CATEGORY_CSS_COLORS, THEME_COLOR, type BreakdownEntry, type ParsedNetWorth, type SelectedCategory } from "./utils";

/** Individual holding, or the aggregate of the smaller holdings folded into one node. */
export interface FlowLeafNode {
  kind: "leaf" | "bucket";
  id: string;
  name: string;
  value: number;
  color: string;
  /** Number of holdings folded into a bucket node (undefined for a plain leaf). */
  bucketedCount?: number;
  /** Opens the same drawer as clicking the parent category. */
  selected: SelectedCategory;
}

/** A breakdown category (Investments, Real Estate, …). */
export interface FlowCategoryNode {
  kind: "category";
  id: string;
  name: string;
  value: number;
  color: string;
  selected: SelectedCategory;
}

/** Assets / Net Worth / Debts — the non-interactive totals on the right of the diagram. */
export interface FlowTotalNode {
  kind: "assets" | "net-worth" | "debts";
  id: string;
  name: string;
  value: number;
  color: string;
}

export type FlowNode = FlowLeafNode | FlowCategoryNode | FlowTotalNode;

export interface FlowLink {
  source: number;
  target: number;
  value: number;
  color: string;
  /** Category key shared with its leaf/category nodes, for hover emphasis. Unset for the Assets -> Net Worth / Debts links. */
  categoryKey?: string;
}

export interface NetWorthFlowGraph {
  nodes: FlowNode[];
  links: FlowLink[];
}

/**
 * Cap on individually-drawn holdings per category before the smallest ones fold
 * into a single "N others" bucket node. Keeps the diagram legible without ever
 * silently dropping a holding — the bucket always carries the exact remainder.
 */
export const MAX_VISIBLE_LEAVES = 4;

/**
 * `usePersistentState` key for whether the Sankey (the expanded state of
 * `CompositionBar`) is open. Defaults to closed — the composition bar is the
 * current/default view; expanding into the flow diagram is opt-in.
 */
export const FLOW_EXPANDED_STORAGE_KEY = "net-worth:flow-expanded";

const EPSILON = 0.005;

export interface FlowLabels {
  assets: string;
  netWorth: string;
  debts: string;
  /** Pluralized label for a bucket node, e.g. "5 smaller holdings". */
  otherHoldings: (count: number) => string;
  /** Label for a remainder not itemized in the category's children. */
  unattributed: string;
}

function categorySelection(category: BreakdownEntry): SelectedCategory {
  return {
    key: category.category,
    name: category.name,
    value: category.value,
    isLiability: false,
    isInvestment: category.category === "investments",
    children: category.children ?? [],
  };
}

/**
 * Strip a trailing parenthetical or date/detail suffix from a leaf's display
 * name — "FundersClub ($236K Basis) - 12/31/2024" -> "FundersClub". Only
 * affects what's rendered on the node label; callers keep the untouched name
 * for the tooltip/aria-label so no information is actually lost.
 */
export function shortenLeafName(name: string): string {
  const withoutParens = name.replace(/\s*\([^()]*\)\s*/g, " ").trim();
  const withoutTrailingDetail = withoutParens.replace(/\s*[-–]\s*[\d/.:]+\s*$/, "").trim();
  return withoutTrailingDetail || name;
}

/**
 * Build the Sankey graph for the Net Worth Flow card from the same
 * `ParsedNetWorth` the breakdown table renders. Pure and side-effect free so
 * it can be unit tested without React or recharts.
 *
 * Layout: leaf holdings -> their category -> Assets -> Net Worth, with Assets
 * also branching to Debts when there are liabilities. Categories with no
 * itemized children (e.g. Cash) skip the leaf layer and link straight to
 * Assets. Returns null when there is nothing to draw.
 *
 * @param investmentAccounts Per-account leaves for the Investments category
 *   (the backend deliberately omits per-holding children there — see
 *   `net_worth_service.rs`). Sourced client-side from current account
 *   valuations. Only used when it doesn't overcount the Investments category
 *   total (see the reconciliation note below); omit/undefined falls back to
 *   today's flat Investments node.
 */
export function buildNetWorthFlowGraph(
  data: ParsedNetWorth,
  labels: FlowLabels,
  investmentAccounts?: BreakdownEntry[],
): NetWorthFlowGraph | null {
  const categories = data.assets.breakdown.filter((category) => category.value > EPSILON);
  if (categories.length === 0) return null;

  const nodes: FlowNode[] = [];
  const links: FlowLink[] = [];
  const push = (node: FlowNode) => nodes.push(node) - 1;

  const categoryLinks: { index: number; value: number; color: string; categoryKey: string }[] = [];

  for (const category of categories) {
    const color = CATEGORY_CSS_COLORS[category.category] ?? "var(--muted-foreground)";
    const selected = categorySelection(category);

    let rawChildren = category.children ?? [];
    if (category.category === "investments" && investmentAccounts && investmentAccounts.length > 0) {
      const candidateTotal = investmentAccounts.reduce((sum, child) => sum + child.value, 0);
      // Per-account values can disagree with the category total (different
      // valuation source/timing than the net-worth snapshot). An undercount
      // is reconciled below with an explicit balancing leaf; an overcount
      // can't be reconciled without fudging one of the two numbers, so fall
      // back to the flat category node rather than show accounts that don't
      // sum to the total directly beneath them in the breakdown table.
      if (candidateTotal - category.value <= EPSILON) {
        rawChildren = investmentAccounts;
      }
    }
    const children = rawChildren.filter((child) => child.value > EPSILON);

    const leafIndices: number[] = [];
    if (children.length > 0) {
      const sorted = [...children].sort((a, b) => b.value - a.value);
      const visibleCount = children.length > MAX_VISIBLE_LEAVES ? MAX_VISIBLE_LEAVES - 1 : children.length;
      const visible = sorted.slice(0, visibleCount);
      const bucketed = sorted.slice(visibleCount);

      for (const child of visible) {
        leafIndices.push(
          push({
            kind: "leaf",
            id: `${category.category}:${child.assetId ?? child.name}`,
            name: child.name,
            value: child.value,
            color,
            selected,
          }),
        );
      }

      if (bucketed.length > 0) {
        const bucketValue = bucketed.reduce((sum, child) => sum + child.value, 0);
        leafIndices.push(
          push({
            kind: "bucket",
            id: `${category.category}:bucket`,
            name: labels.otherHoldings(bucketed.length),
            value: bucketValue,
            color,
            bucketedCount: bucketed.length,
            selected,
          }),
        );
      }

      // Children rarely sum to exactly the category total (e.g. a rounding
      // remainder). Never let the diagram silently drop that difference —
      // surface it as an explicit unattributed leaf.
      const childrenTotal = children.reduce((sum, child) => sum + child.value, 0);
      const remainder = category.value - childrenTotal;
      if (Math.abs(remainder) > EPSILON) {
        leafIndices.push(
          push({
            kind: "leaf",
            id: `${category.category}:unattributed`,
            name: labels.unattributed,
            value: remainder,
            color,
            selected,
          }),
        );
      }
    }

    const categoryIndex = push({
      kind: "category",
      id: category.category,
      name: category.name,
      value: category.value,
      color,
      selected,
    });

    for (const leafIndex of leafIndices) {
      const leaf = nodes[leafIndex] as FlowLeafNode;
      links.push({
        source: leafIndex,
        target: categoryIndex,
        value: leaf.value,
        color,
        categoryKey: category.category,
      });
    }

    categoryLinks.push({ index: categoryIndex, value: category.value, color, categoryKey: category.category });
  }

  const assetsIndex = push({
    kind: "assets",
    id: "assets",
    name: labels.assets,
    value: data.assets.total,
    color: THEME_COLOR,
  });
  for (const link of categoryLinks) {
    links.push({
      source: link.index,
      target: assetsIndex,
      value: link.value,
      color: link.color,
      categoryKey: link.categoryKey,
    });
  }

  // A Sankey flow can't carry a negative value, so a negative net worth (debts
  // exceeding assets) has no honest "Assets -> Net Worth" ribbon to draw —
  // omit that branch rather than fake one. The card's own total still shows
  // the true (negative) figure in text.
  if (data.netWorth > EPSILON) {
    const netWorthIndex = push({
      kind: "net-worth",
      id: "net-worth",
      name: labels.netWorth,
      value: data.netWorth,
      color: THEME_COLOR,
    });
    links.push({ source: assetsIndex, target: netWorthIndex, value: data.netWorth, color: THEME_COLOR });
  }

  if (data.liabilities.total > EPSILON) {
    const debtsIndex = push({
      kind: "debts",
      id: "debts",
      name: labels.debts,
      value: data.liabilities.total,
      color: "var(--destructive)",
    });
    links.push({
      source: assetsIndex,
      target: debtsIndex,
      value: data.liabilities.total,
      color: "var(--destructive)",
    });
  }

  return { nodes, links };
}
