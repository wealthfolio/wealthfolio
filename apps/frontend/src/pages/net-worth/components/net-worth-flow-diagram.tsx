import { useBalancePrivacy } from "@/hooks/use-balance-privacy";
import { formatCompactAmount } from "@wealthfolio/ui";
import { useId, useMemo, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { ResponsiveContainer, Sankey } from "recharts";
import type { LinkProps as RechartsLinkProps, NodeProps as RechartsNodeProps } from "recharts/types/chart/Sankey";
import type { FlowNode, NetWorthFlowGraph } from "./net-worth-flow-utils";
import { THEME_COLOR, type SelectedCategory } from "./utils";

const NODE_WIDTH = 8;
const LABEL_GAP = 6;

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
  currency: string;
  isMobile: boolean;
  hoveredCategory: string | null;
  onHover: (key: string | null) => void;
  onSelect: (selected: SelectedCategory) => void;
  isBalanceHidden: boolean;
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
 */
function FlowNodeShape({
  x,
  y,
  width,
  height,
  payload,
  ctx,
  t,
}: RechartsNodeProps & { ctx: ShapeContext; t: (key: string, options?: Record<string, unknown>) => string }) {
  const node = payload as unknown as FlowNode;
  const selectable = isSelectable(node);
  const categoryKey = selectable ? node.selected.key : undefined;
  const dimmed = ctx.hoveredCategory != null && categoryKey != null && ctx.hoveredCategory !== categoryKey;
  const rectHeight = Math.max(height, 1.5);
  const rightAligned = RIGHT_ALIGNED_KINDS.has(node.kind);
  const showValue = VALUE_KINDS.has(node.kind);
  // Leaf/bucket labels are dropped at narrow widths (embedded in the
  // breakdown card, roughly 700-760px) so the diagram degrades to
  // category -> Assets -> Net Worth / Debts instead of scrolling sideways.
  const showLabel = !ctx.isMobile || (node.kind !== "leaf" && node.kind !== "bucket");

  const amountText = ctx.isBalanceHidden ? "••••" : formatCompactAmount(node.value, ctx.currency);
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
      <rect x={x} y={y} width={width} height={rectHeight} rx={1.5} fill={fill}>
        <title>{`${node.name} — ${amountText}`}</title>
      </rect>
      {showLabel && (
        <foreignObject x={labelX} y={y} width={labelWidth} height={Math.max(rectHeight, 26)}>
          {/* No xmlns attribute needed: the app always parses this as HTML5,
              which puts foreignObject's children in the HTML namespace already. */}
          <div
            className={`flex flex-col leading-tight ${rightAligned ? "items-end text-right" : "items-start text-left"}`}
          >
            <span className="text-foreground truncate text-[11px] font-medium" style={{ maxWidth: labelWidth }}>
              {node.name}
            </span>
            {showValue && (
              <span
                className="text-muted-foreground/70 truncate text-[10px] tabular-nums"
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
  payload,
  ctx,
}: RechartsLinkProps & { ctx: ShapeContext }) {
  const link = payload as unknown as { color: string; categoryKey?: string; target: FlowNode };
  const dimmed = ctx.hoveredCategory != null && link.categoryKey != null && ctx.hoveredCategory !== link.categoryKey;
  const hot = ctx.hoveredCategory != null && ctx.hoveredCategory === link.categoryKey;
  const convergesIntoAssets = link.categoryKey != null && link.target.kind === "assets";
  const stroke = convergesIntoAssets ? `url(#${ctx.uid}-converge-${link.categoryKey})` : link.color;

  return (
    <path
      d={`M${sourceX},${sourceY} C${sourceControlX},${sourceY} ${targetControlX},${targetY} ${targetX},${targetY}`}
      fill="none"
      stroke={stroke}
      strokeWidth={Math.max(linkWidth, 1)}
      strokeOpacity={dimmed ? 0.12 : hot ? 0.82 : 0.42}
      style={{ transition: "stroke-opacity 120ms ease" }}
      onMouseEnter={() => link.categoryKey && ctx.onHover(link.categoryKey)}
      onMouseLeave={() => link.categoryKey && ctx.onHover(null)}
    />
  );
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
 */
export function NetWorthFlowDiagram({ graph, currency, onSelect, isMobile }: NetWorthFlowDiagramProps) {
  const { t } = useTranslation();
  const { isBalanceHidden } = useBalancePrivacy();
  const [hoveredCategory, setHoveredCategory] = useState<string | null>(null);
  const uid = `nwf-${useId().replace(/:/g, "")}`;

  const categoryColors = useMemo(
    () =>
      graph.nodes
        .filter((node) => node.kind === "category")
        .map((node) => ({ key: node.selected.key, color: node.color })),
    [graph.nodes],
  );

  const ctx: ShapeContext = {
    currency,
    isMobile,
    hoveredCategory,
    onHover: setHoveredCategory,
    onSelect,
    isBalanceHidden,
    uid,
  };

  return (
    <div className="h-[300px] w-full overflow-x-auto md:h-[340px]">
      <ResponsiveContainer width="100%" height="100%" minWidth={320}>
        <Sankey
          data={{ nodes: graph.nodes, links: graph.links }}
          nodeWidth={NODE_WIDTH}
          nodePadding={isMobile ? 8 : 12}
          linkCurvature={0.55}
          iterations={32}
          margin={{ top: 8, right: 8, bottom: 8, left: 8 }}
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
                <rect width={7} height={7} fill={color} />
                <rect width={3.5} height={7} fill="var(--bar-stripe)" />
              </pattern>
            ))}
            {categoryColors.map(({ key, color }) => (
              <linearGradient key={`grad-${key}`} id={`${uid}-converge-${key}`} x1="0" y1="0" x2="1" y2="0">
                <stop offset="0%" stopColor={color} />
                <stop offset="100%" stopColor={THEME_COLOR} />
              </linearGradient>
            ))}
          </defs>
        </Sankey>
      </ResponsiveContainer>
    </div>
  );
}
