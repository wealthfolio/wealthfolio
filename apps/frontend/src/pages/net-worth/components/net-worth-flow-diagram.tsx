import { useAccounts } from "@/hooks/use-accounts";
import { useBalancePrivacy } from "@/hooks/use-balance-privacy";
import { useCurrentAccountValuations } from "@/hooks/use-current-account-valuations";
import { useIsMobileViewport } from "@/hooks/use-platform";
import { useAmountFormatting } from "@wealthfolio/ui";
import { useId, useMemo, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  ResponsiveContainer,
  Sankey,
  type SankeyLinkProps as RechartsLinkProps,
  type SankeyNodeProps as RechartsNodeProps,
} from "recharts";
import {
  buildNetWorthFlowGraph,
  shortenLeafName,
  type FlowNode,
  type NetWorthFlowGraph,
} from "./net-worth-flow-utils";
import {
  THEME_COLOR,
  type BreakdownEntry,
  type ParsedNetWorth,
  type SelectedCategory,
} from "./utils";

const NODE_WIDTH = 8;
const LABEL_GAP = 6;
/**
 * Minimum vertical distance guaranteed between the tops of two adjacent nodes
 * in the same column — a floor independent of either node's value. This is
 * `nodePadding`, and it's what makes label collisions structurally
 * impossible rather than something detected and patched after layout: a
 * two-line label (name + amount) needs ~24-26px, so leaving this much room
 * around every node means a leaf's label always has a fully clear row, no
 * matter how small the ribbon feeding it is. Mobile hides leaf/bucket labels
 * entirely (see `showLabel`), so it only needs enough room for the sparser
 * category/total labels.
 */
const ROW_PITCH_DESKTOP = 28;
const ROW_PITCH_MOBILE = 14;

/**
 * A leaf label is a fixed-height box anchored at its node's TOP edge (see the
 * `foreignObject` in `FlowNodeShape`), so the bottom-most node's label extends
 * this far BELOW the node itself. The chart's bottom margin must reserve at
 * least this much or that last label is clipped by the SVG viewport — which is
 * exactly what happened: every row rendered correctly except the last, whose
 * text was sliced in half.
 *
 * Kept as its own constant, and used for both the margin and the height
 * budget, so the two cannot drift apart.
 */
const LABEL_BOX_HEIGHT = 24;

interface NetWorthFlowDiagramProps {
  graph: NetWorthFlowGraph;
  currency: string;
  onSelect: (selected: SelectedCategory) => void;
  isMobile: boolean;
}

/** Kinds whose node sits at the right edge of the diagram — their label reads to the left. */
const RIGHT_ALIGNED_KINDS = new Set<FlowNode["kind"]>(["net-worth", "debts"]);
/** Kinds that open the breakdown drawer on click/Enter/Space. */
const SELECTABLE_KINDS = new Set<FlowNode["kind"]>(["leaf", "bucket", "category"]);
/**
 * Only the terminal totals show a value in the diagram — they appear nowhere
 * else on the page in that shape. Every other node (and Net Worth, already
 * the headline number in the Balance card above) shows its name only; exact
 * values live in the breakdown table rows and the drawer the node opens, so
 * this diagram never has its own number to disagree with theirs.
 */
const VALUE_KINDS = new Set<FlowNode["kind"]>(["assets", "debts"]);

function isSelectable(node: FlowNode): node is FlowNode & { selected: SelectedCategory } {
  return SELECTABLE_KINDS.has(node.kind);
}

interface ShapeContext {
  isMobile: boolean;
  hoveredCategory: string | null;
  onHover: (key: string | null) => void;
  onSelect: (selected: SelectedCategory) => void;
  isBalanceHidden: boolean;
  formatAmount: (value: number) => string;
  /** `nwf-<uid>` — shared prefix for this diagram's <defs> ids (bucket stripes, converge gradients). */
  uid: string;
}

/**
 * A node's rect + an HTML label rendered via foreignObject, so a holding name
 * truncates like everywhere else in the app instead of SVG text overflowing
 * with no ellipsis. Bucket nodes get a diagonal stripe in their category's own
 * color (the same `--bar-stripe` overlay the budget meters use) to flag "this
 * is several holdings, not one" rather than rendering them as an
 * indistinguishable hairline.
 *
 * Every leaf/bucket label gets its own opaque per-line chip behind the text
 * (rather than relying on empty space), so even a ribbon that happens to
 * pass close to the label gutter can never visually cut through it. The real
 * anti-overlap guarantee is structural, not visual: see `ROW_PITCH_DESKTOP`
 * and `diagramHeight` in `NetWorthFlowDiagram` — labels never collide
 * because every node in a column is spaced at least one label-height apart
 * by construction, and `MAX_VISIBLE_LEAVES` (net-worth-flow-utils.ts) caps
 * how many individually-labeled leaves a category can have in the first
 * place, folding the rest into a bucket instead.
 */
function FlowNodeShape({
  x,
  y,
  width,
  height,
  payload,
  ctx,
  t,
}: RechartsNodeProps & {
  ctx: ShapeContext;
  t: (key: string, options?: Record<string, unknown>) => string;
}) {
  const node = payload as unknown as FlowNode;
  const selectable = isSelectable(node);
  const categoryKey = selectable ? node.selected.key : undefined;
  const dimmed =
    ctx.hoveredCategory != null && categoryKey != null && ctx.hoveredCategory !== categoryKey;
  const rectHeight = Math.max(height, 1.5);
  const rightAligned = RIGHT_ALIGNED_KINDS.has(node.kind);
  const showValue = VALUE_KINDS.has(node.kind);
  const isLeafOrBucket = node.kind === "leaf" || node.kind === "bucket";
  // Leaf/bucket labels are dropped at narrow widths (embedded in the
  // breakdown card, roughly 700-760px) so the diagram degrades to
  // category -> Assets -> Net Worth / Debts instead of scrolling sideways.
  const showLabel = !ctx.isMobile || !isLeafOrBucket;
  const displayName = isLeafOrBucket ? shortenLeafName(node.name) : node.name;

  const amountText = ctx.isBalanceHidden ? "••••" : ctx.formatAmount(node.value);
  const ariaLabel = selectable
    ? t("insights:networth.flow.node_aria", { name: node.name, amount: amountText })
    : undefined;

  const handleClick = () => {
    if (selectable) ctx.onSelect(node.selected);
  };
  const handleKeyDown = (event: KeyboardEvent<SVGGElement>) => {
    if (!selectable) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      ctx.onSelect(node.selected);
    }
  };

  const labelWidth = ctx.isMobile ? 68 : 92;
  const labelX = rightAligned ? x - LABEL_GAP - labelWidth : x + width + LABEL_GAP;
  const fill = node.kind === "bucket" ? `url(#${ctx.uid}-stripe-${categoryKey})` : node.color;

  return (
    <g
      className="nwf-node"
      tabIndex={selectable ? 0 : undefined}
      role={selectable ? "button" : undefined}
      aria-label={ariaLabel}
      style={{ cursor: selectable ? "pointer" : "default", opacity: dimmed ? 0.35 : 1 }}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      onMouseEnter={() => categoryKey && ctx.onHover(categoryKey)}
      onMouseLeave={() => categoryKey && ctx.onHover(null)}
      onFocus={() => categoryKey && ctx.onHover(categoryKey)}
      onBlur={() => categoryKey && ctx.onHover(null)}
    >
      <rect x={x} y={y} width={width} height={rectHeight} rx={1.5} style={{ fill }}>
        <title>{`${node.name} — ${amountText}`}</title>
      </rect>
      {showLabel && (
        <foreignObject
          x={labelX}
          y={y}
          width={labelWidth}
          height={Math.max(rectHeight, LABEL_BOX_HEIGHT)}
          style={{ overflow: "visible" }}
        >
          {/* No xmlns attribute needed: the app always parses this as HTML5,
              which puts foreignObject's children in the HTML namespace already.
              The diagram's columns are physical SVG coordinates that do not
              mirror in RTL, so the label box is pinned to LTR for alignment and
              each text span takes its own direction from its content. */}
          <div
            dir="ltr"
            className={`flex flex-col justify-center leading-tight ${rightAligned ? "items-end text-end" : "items-start text-start"}`}
            style={{ minHeight: "100%" }}
          >
            <span
              dir="auto"
              className="bg-background/90 text-foreground text-2xs inline-block truncate rounded-sm px-0.5 font-medium"
              style={{ maxWidth: labelWidth }}
            >
              {displayName}
            </span>
            {showValue && (
              <span
                dir="auto"
                className="bg-background/90 text-muted-foreground/70 text-2xs inline-block truncate rounded-sm px-0.5 tabular-nums"
                style={{ maxWidth: labelWidth, fontVariantNumeric: "tabular-nums" }}
              >
                {amountText}
              </span>
            )}
          </div>
        </foreignObject>
      )}
    </g>
  );
}

/**
 * A category -> Assets ribbon fades from the category color into the shared
 * net-worth theme color as it converges — the same gradient trick the
 * history sparkline above uses — so "everything converges into one number"
 * reads visually, not just structurally.
 */
function FlowLinkShape({
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourceControlX,
  targetControlX,
  linkWidth,
  index,
  payload,
  ctx,
}: RechartsLinkProps & { ctx: ShapeContext }) {
  const link = payload as unknown as { color: string; categoryKey?: string; target: FlowNode };
  const dimmed =
    ctx.hoveredCategory != null &&
    link.categoryKey != null &&
    ctx.hoveredCategory !== link.categoryKey;
  const hot = ctx.hoveredCategory != null && ctx.hoveredCategory === link.categoryKey;
  const convergesIntoAssets = link.categoryKey != null && link.target.kind === "assets";
  // Per-link, in user space: an objectBoundingBox gradient paints nothing on a
  // perfectly horizontal ribbon, whose bounding box has zero height.
  const gradientId = `${ctx.uid}-converge-${index}`;
  const stroke = convergesIntoAssets ? `url(#${gradientId})` : link.color;

  return (
    <g>
      {convergesIntoAssets && (
        <defs>
          <linearGradient
            id={gradientId}
            gradientUnits="userSpaceOnUse"
            x1={sourceX}
            x2={targetX}
            y1={0}
            y2={0}
          >
            <stop offset="0%" style={{ stopColor: link.color }} />
            <stop offset="100%" style={{ stopColor: THEME_COLOR }} />
          </linearGradient>
        </defs>
      )}
      <path
        d={`M${sourceX},${sourceY} C${sourceControlX},${sourceY} ${targetControlX},${targetY} ${targetX},${targetY}`}
        fill="none"
        strokeWidth={Math.max(linkWidth, 1)}
        strokeOpacity={dimmed ? 0.12 : hot ? 0.82 : 0.42}
        style={{ stroke, transition: "stroke-opacity 120ms ease" }}
        onMouseEnter={() => link.categoryKey && ctx.onHover(link.categoryKey)}
        onMouseLeave={() => link.categoryKey && ctx.onHover(null)}
      />
    </g>
  );
}

/**
 * Number of nodes stacked in the diagram's leftmost (most crowded) column —
 * every leaf/bucket, plus any category with no itemized children (e.g. Cash,
 * which links straight to Assets and therefore starts at the same depth as
 * everyone else's leaves). Nodes are "leftmost" when nothing links into them.
 */
function leadingColumnNodeCount(graph: NetWorthFlowGraph): number {
  const hasIncoming = new Set(graph.links.map((link) => link.target));
  return graph.nodes.filter((_, index) => !hasIncoming.has(index)).length;
}

/**
 * Sankey diagram of how holdings roll up into categories, into total assets,
 * then into net worth (with debts branching off). Reads the same graph
 * `buildNetWorthFlowGraph` derives from `ParsedNetWorth` — no API call of its
 * own.
 *
 * Chrome-less by design: it's the expanded state of `CompositionBar` inside
 * `BreakdownTable` (which owns the collapse trigger and persisted state), not
 * a standalone card. It shows no values except on the Assets/Debts terminal
 * nodes (which appear nowhere else on the page in that shape); the
 * breakdown table rows are the ledger of exact values, percentages and
 * change. Category and leaf/bucket nodes open the same detail drawer the
 * breakdown table's rows do; the Assets / Net Worth / Debts totals are
 * non-interactive, matching the breakdown table's own total row having no
 * click handler either.
 *
 * Labels never collide by construction, not by detecting and patching
 * overlaps after the fact: `nodePadding` is fixed at `ROW_PITCH_DESKTOP`
 * (independent of any node's value, so the smallest leaf gets exactly as much
 * clearance as the largest), and the diagram's own height grows with the
 * leftmost column's node count so that pitch always fits inside it — see
 * `leadingColumnNodeCount` / `diagramHeight` below. A leaf that would need
 * more rows than `MAX_VISIBLE_LEAVES` allows never reaches this component in
 * the first place; it's folded into its category's bucket node upstream in
 * `buildNetWorthFlowGraph`.
 */
export function NetWorthFlowDiagram({
  graph,
  currency,
  onSelect,
  isMobile,
}: NetWorthFlowDiagramProps) {
  const { t } = useTranslation();
  const { isBalanceHidden } = useBalancePrivacy();
  const formatting = useAmountFormatting();
  const [hoveredCategory, setHoveredCategory] = useState<string | null>(null);
  const uid = `nwf-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;

  const rowPitch = isMobile ? ROW_PITCH_MOBILE : ROW_PITCH_DESKTOP;
  const leadingCount = useMemo(() => leadingColumnNodeCount(graph), [graph]);
  // recharts' Sankey scales every node's thickness by ONE shared ratio,
  // `(columnHeight - (n-1)*nodePadding) / sum(columnValues)`, taken as the
  // min across all columns — so budgeting only just enough height for the
  // pitch floor would starve every node's thickness to near-zero (the
  // leftmost column has by far the most nodes to pad between). Reserve real
  // room on top of the pitch floor so values still read as proportional
  // ribbon thickness, not just as evenly-spaced hairlines.
  const valueHeightBudget = isMobile ? 60 : 140;
  // + LABEL_BOX_HEIGHT so the bottom margin below can reserve room for the last
  // node's label without eating into the plotted area.
  const diagramHeight = Math.min(
    680 + LABEL_BOX_HEIGHT,
    Math.max(isMobile ? 260 : 300, leadingCount * rowPitch + valueHeightBudget) + LABEL_BOX_HEIGHT,
  );

  const categoryColors = useMemo(
    () =>
      graph.nodes
        .filter((node) => node.kind === "category")
        .map((node) => ({ key: node.selected.key, color: node.color })),
    [graph.nodes],
  );

  const ctx: ShapeContext = {
    isMobile,
    hoveredCategory,
    onHover: setHoveredCategory,
    onSelect,
    isBalanceHidden,
    formatAmount: (value) => formatting.formatCompactAmount(value, currency, true, "narrowSymbol"),
    uid,
  };

  return (
    <div className="w-full overflow-x-auto" style={{ height: diagramHeight }}>
      <ResponsiveContainer width="100%" height="100%" minWidth={320}>
        {/* The nodes are the diagram's Tab stops; Recharts' accessibility layer
            would add the whole SVG as another. */}
        <Sankey
          accessibilityLayer={false}
          data={{ nodes: graph.nodes, links: graph.links }}
          nodeWidth={NODE_WIDTH}
          nodePadding={rowPitch}
          linkCurvature={0.55}
          iterations={32}
          // bottom reserves a full label box: labels hang BELOW their node's top
          // edge, so the last row is clipped without it.
          margin={{ top: 8, right: 8, bottom: LABEL_BOX_HEIGHT, left: 8 }}
          node={(props: RechartsNodeProps) => <FlowNodeShape {...props} ctx={ctx} t={t} />}
          link={(props: RechartsLinkProps) => <FlowLinkShape {...props} ctx={ctx} />}
        >
          <defs>
            {categoryColors.map(({ key, color }) => (
              <pattern
                key={`stripe-${key}`}
                id={`${uid}-stripe-${key}`}
                width={7}
                height={7}
                patternTransform="rotate(45)"
                patternUnits="userSpaceOnUse"
              >
                <rect width={7} height={7} style={{ fill: color }} />
                <rect width={3.5} height={7} style={{ fill: "var(--bar-stripe)" }} />
              </pattern>
            ))}
          </defs>
        </Sankey>
      </ResponsiveContainer>
    </div>
  );
}

interface NetWorthFlowProps {
  data: ParsedNetWorth;
  currency: string;
  onSelect: (selected: SelectedCategory) => void;
}

/**
 * The expanded state of the breakdown card's composition bar: builds the flow
 * graph and renders the diagram. Mounted only while expanded, so the account
 * valuations it reads are fetched only when someone opens the flow.
 */
export function NetWorthFlow({ data, currency, onSelect }: NetWorthFlowProps) {
  const { t } = useTranslation();
  const isMobile = useIsMobileViewport();

  // The Investments category deliberately has no per-holding children from the
  // backend (hundreds of holdings; the allocation view owns that drill-down —
  // see net_worth_service.rs). Fan the Investments node in by ACCOUNT instead,
  // from current account valuations. `undefined` while accounts/valuations are
  // still loading, which `buildNetWorthFlowGraph` treats as "no data" and
  // falls back to the flat Investments node.
  const { accounts } = useAccounts();
  const accountIds = useMemo(() => accounts.map((account) => account.id), [accounts]);
  const { currentAccountValuations, isLoading } = useCurrentAccountValuations(accountIds);
  const investmentAccounts = useMemo((): BreakdownEntry[] | undefined => {
    if (!currentAccountValuations || isLoading) return undefined;
    const accountNameById = new Map(accounts.map((account) => [account.id, account.name]));
    return currentAccountValuations
      .filter((valuation) => valuation.investmentMarketValueBase > 0)
      .map((valuation) => ({
        category: "investments",
        name: accountNameById.get(valuation.accountId) ?? valuation.accountId,
        value: valuation.investmentMarketValueBase,
        assetId: valuation.accountId,
      }));
  }, [accounts, currentAccountValuations, isLoading]);

  const graph = useMemo(
    () =>
      buildNetWorthFlowGraph(
        data,
        {
          assets: t("insights:networth.breakdown_table.assets"),
          netWorth: t("insights:networth.breakdown_table.net_worth"),
          debts: t("insights:networth.flow.debts_label"),
          otherHoldings: (count) => t("insights:networth.flow.other_holdings", { count }),
          unattributed: t("insights:networth.flow.unattributed"),
        },
        investmentAccounts,
      ),
    [data, investmentAccounts, t],
  );

  if (!graph) return null;
  return (
    <div className="pt-3">
      <NetWorthFlowDiagram
        graph={graph}
        currency={currency}
        onSelect={onSelect}
        isMobile={isMobile}
      />
    </div>
  );
}
