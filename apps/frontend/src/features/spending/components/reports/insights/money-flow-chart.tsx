import { motion, useReducedMotion } from "motion/react";
import { useCallback, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { ResponsiveContainer, Sankey, type SankeyLinkProps, type SankeyNodeProps } from "recharts";

import { useBalancePrivacy } from "@/hooks/use-balance-privacy";
import { PrivacyAmount, useAmountFormatting, useNumberFormatting } from "@wealthfolio/ui";

import {
  isFocusable,
  type MoneyFlowGraph,
  type MoneyFlowNode,
  type MoneyFlowNodeKind,
} from "../../../lib/money-flow";
import { formatPercentValue } from "./format";

const NODE_WIDTH = 8;
const LABEL_GAP = 8;
const NAME_FONT: LabelFont = { size: 11, weight: 500 };
const AMOUNT_FONT: LabelFont = { size: 10.5, weight: 400 };
/** Vertical extent of a two-line label around its node's centre. */
const LABEL_TOP = 13;
const LABEL_BOTTOM = 15;
/**
 * `nodePadding`: the minimum gap between two nodes of a column, independent of
 * their values. A two-line label (name + amount) is ~24px tall and centred on
 * its node, so with this much clearance neighbouring labels cannot collide.
 */
const ROW_PITCH = 30;
/** Height reserved for the ribbons themselves on top of the label rows. */
const VALUE_HEIGHT = { desktop: 180, mobile: 110 };
const MIN_HEIGHT = 240;
/** Room beside the outer columns for their labels: sized to the longest one, within bounds. */
const GUTTER = { desktop: { min: 72, max: 210 }, mobile: { min: 56, max: 104 } };
/** A zoomed, two-column chart has room to spare for category names on phones. */
const MOBILE_ZOOMED_GUTTER_MAX = 150;
/** Labels of middle columns sit over ribbons, before the next column. */
const MIDDLE_LABEL_WIDTH = { desktop: 150, mobile: 72 };
const MAX_TOOLTIP_MEMBERS = 5;
/** Matches the tooltip's `w-60`; used to keep it inside the chart. */
const TOOLTIP_WIDTH = 240;
const TOOLTIP_EDGE = 8;
/** How far the tooltip's near edge sits past its node's centre. */
const TOOLTIP_ANCHOR_OFFSET = 24;

const HINT_KEYS: Partial<Record<MoneyFlowNodeKind, string>> = {
  total: "spending:moneyFlow.hint.total",
  shortfall: "spending:moneyFlow.hint.shortfall",
  refunds: "spending:moneyFlow.hint.refunds",
  saved: "spending:moneyFlow.hint.saved",
  surplus: "spending:moneyFlow.hint.surplus",
  uncategorized: "spending:moneyFlow.hint.uncategorized",
};

type PositionedNode = MoneyFlowNode & { x: number; y: number; dx: number; dy: number };

interface LabelFont {
  size: number;
  weight: number;
}

interface ActiveNode {
  node: MoneyFlowNode;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface MoneyFlowChartProps {
  graph: MoneyFlowGraph;
  currency: string;
  isMobile: boolean;
  onCategoryClick?: (categoryId: string) => void;
  /** Zoom into a destination (a group, Set aside, or a group's folded remainder). */
  onFocusNode?: (nodeId: string) => void;
  /** Node to take keyboard focus once rendered — where a zoom was left from. */
  autoFocusNodeId?: string | null;
  onAutoFocused?: () => void;
}

/**
 * Sankey of the period's money: income sources → total → destinations →
 * categories, as built by `buildMoneyFlowGraph`. Columns keep the builder's
 * order (`sort={false}`) so ribbons never cross and the layout stays stable
 * between periods. Hovering or focusing a node lights its path and shows a
 * tooltip; categories open their transactions and destinations zoom in.
 */
export function MoneyFlowChart({
  graph,
  currency,
  isMobile,
  onCategoryClick,
  onFocusNode,
  autoFocusNodeId,
  onAutoFocused,
}: MoneyFlowChartProps) {
  const { t } = useTranslation();
  const { isBalanceHidden } = useBalancePrivacy();
  const { formatRoundedAmount } = useAmountFormatting();
  const reduceMotion = useReducedMotion();
  const uid = `mf-${useId().replace(/:/g, "")}`;
  const tooltipId = `${uid}-tooltip`;
  const [active, setActive] = useState<ActiveNode | null>(null);
  // The keyboard-focused node keeps its tooltip after the mouse passes over others.
  const focused = useRef<ActiveNode | null>(null);
  // One Tab stop for the whole chart; arrow keys move between nodes (roving tabindex).
  const [rovingId, setRovingId] = useState<string | null>(null);
  const chartRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const measure = useTextMeasure();
  const autoFocused = useRef(false);
  const focusOnMount = useCallback(
    (element: SVGGElement | null) => {
      if (!element || autoFocused.current) return;
      autoFocused.current = true;
      element.focus();
      onAutoFocused?.();
    },
    [onAutoFocused],
  );

  const lastColumn = useMemo(
    () => graph.nodes.reduce((max, node) => Math.max(max, node.column), 0),
    [graph.nodes],
  );
  const data = useMemo(() => {
    const index = new Map(graph.nodes.map((node, i) => [node.id, i]));
    return {
      nodes: graph.nodes,
      links: graph.links.flatMap((link) => {
        const source = index.get(link.source);
        const target = index.get(link.target);
        return source === undefined || target === undefined
          ? []
          : [{ source, target, value: link.value }];
      }),
    };
  }, [graph]);
  const lineage = useMemo(
    () => (active ? lineageOf(graph, active.node.id) : null),
    [graph, active],
  );
  const inGraph = (id: string | null | undefined) => graph.nodes.some((node) => node.id === id);
  const tabStopId = inGraph(rovingId)
    ? rovingId
    : inGraph(autoFocusNodeId)
      ? autoFocusNodeId
      : graph.nodes[0]?.id;

  const formatValue = (value: number) =>
    isBalanceHidden ? "••••" : formatRoundedAmount(value, currency);

  const device = isMobile ? "mobile" : "desktop";
  const gutterMax = isMobile && lastColumn <= 1 ? MOBILE_ZOOMED_GUTTER_MAX : GUTTER[device].max;
  const outerLabelMax = gutterMax - LABEL_GAP * 2;
  const fitName = (node: MoneyFlowNode, maxWidth: number) =>
    fitText(node.name, maxWidth, (text) => measure(text, NAME_FONT));
  const gutterFor = (column: number) => {
    let widest = 0;
    for (const node of graph.nodes) {
      if (node.column !== column) continue;
      widest = Math.max(
        widest,
        measure(fitName(node, outerLabelMax), NAME_FONT),
        measure(formatValue(node.value), AMOUNT_FONT),
      );
    }
    return Math.min(gutterMax, Math.max(GUTTER[device].min, widest + LABEL_GAP * 2));
  };
  const rows = Math.max(...columnSizes(graph.nodes));
  const height = Math.max(MIN_HEIGHT, rows * ROW_PITCH + VALUE_HEIGHT[device]);
  const left = gutterFor(0);
  const right = gutterFor(lastColumn);
  const margin = useMemo(() => ({ top: 14, bottom: 14, left, right }), [left, right]);
  // A middle label may not reach past the space before the next column.
  const columnGap = lastColumn > 0 ? (width - left - right - NODE_WIDTH) / lastColumn : 0;
  const middleLabelMax =
    columnGap > 0
      ? Math.min(MIDDLE_LABEL_WIDTH[device], columnGap - LABEL_GAP * 3)
      : MIDDLE_LABEL_WIDTH[device];

  // Touch has no hover: there a tap opens the tooltip instead (see `onClick`).
  const activate = (next: ActiveNode | null) => {
    if (!isMobile) setActive(next);
  };

  const select = (node: MoneyFlowNode) => {
    if (node.categoryId) onCategoryClick?.(node.categoryId);
    else if (isFocusable(node)) onFocusNode?.(node.parentId ?? node.id);
  };

  const renderNode = (props: SankeyNodeProps) => {
    const node = props.payload as unknown as PositionedNode;
    const interactive = !!node.categoryId || (isFocusable(node) && !!onFocusNode);
    const dimmed = lineage != null && !lineage.has(node.id);
    const labelLeft = node.column === 0 && lastColumn > 0;
    const isOuter = node.column === 0 || node.column === lastColumn;
    const name = fitName(node, isOuter ? outerLabelMax : middleLabelMax);
    const amount = formatValue(node.value);
    const labelWidth = Math.max(measure(name, NAME_FONT), measure(amount, AMOUNT_FONT));
    const textX = labelLeft ? props.x - LABEL_GAP : props.x + props.width + LABEL_GAP;
    const labelX = labelLeft ? textX - labelWidth : textX;
    const centerY = props.y + props.height / 2;
    const nodeHeight = Math.max(props.height, 2);
    const box = { x: props.x, y: props.y, width: props.width, height: props.height };
    // The bar is only 8px wide: the whole node-plus-label block takes the pointer.
    const hitX = Math.min(props.x, labelX) - 4;
    const hitY = Math.min(props.y, centerY - LABEL_TOP);
    const hitWidth = Math.max(props.x + props.width, labelX + labelWidth) + 4 - hitX;
    const hitHeight = Math.max(props.y + nodeHeight, centerY + LABEL_BOTTOM) - hitY;

    const onKeyDown = (event: KeyboardEvent<SVGGElement>) => {
      if (interactive && (event.key === "Enter" || event.key === " ")) {
        event.preventDefault();
        select(node);
        return;
      }
      // Modified arrows stay the browser's (Alt+Arrow is back/forward).
      if (!NAVIGATION_KEYS.has(event.key) || event.altKey || event.ctrlKey || event.metaKey) {
        return;
      }
      // Arrows move within the chart even at its ends, rather than scrolling the page.
      event.preventDefault();
      const next = neighbourOf(graph, node, event.key);
      if (!next) return;
      setRovingId(next.id);
      chartRef.current
        ?.querySelector<SVGGElement>(`[data-node-id="${CSS.escape(next.id)}"]`)
        ?.focus();
    };

    // Every node is reachable by keyboard so its tooltip (hints, folded
    // members) is too; only categories and destinations act on Enter.
    return (
      <g
        key={node.id}
        ref={node.id === autoFocusNodeId ? focusOnMount : undefined}
        data-node-id={node.id}
        role={interactive ? "button" : "img"}
        tabIndex={node.id === tabStopId ? 0 : -1}
        aria-label={t("spending:moneyFlow.nodeAria", { name: node.name, amount })}
        aria-describedby={active?.node.id === node.id ? tooltipId : undefined}
        className="group outline-none"
        style={{
          cursor: interactive || isMobile ? "pointer" : "default",
          opacity: dimmed ? 0.3 : 1,
          transition: "opacity 150ms ease",
        }}
        onClick={() => {
          if (interactive) select(node);
          else if (isMobile) {
            setActive((current) => (current?.node.id === node.id ? null : { node, ...box }));
          }
        }}
        onKeyDown={onKeyDown}
        onMouseEnter={() => activate({ node, ...box })}
        onMouseLeave={() => activate(focused.current)}
        onFocus={(event) => {
          setRovingId(node.id);
          // A click focuses the node too; only keyboard focus pins the tooltip.
          if (!event.currentTarget.matches(":focus-visible")) return;
          focused.current = { node, ...box };
          activate(focused.current);
        }}
        onBlur={() => {
          focused.current = null;
          setActive(null);
        }}
      >
        <rect
          x={hitX}
          y={hitY}
          width={hitWidth}
          height={hitHeight}
          style={{ fill: "transparent" }}
        />
        {node.kind === "more" ? (
          <rect
            x={props.x}
            y={props.y}
            width={props.width}
            height={nodeHeight}
            rx={2}
            style={{ fill: `url(#${uid}-stripe-${patternKey(node.color)})` }}
          />
        ) : (
          <rect
            x={props.x}
            y={props.y}
            width={props.width}
            height={nodeHeight}
            rx={2}
            style={{ fill: node.color }}
          />
        )}
        <rect
          x={props.x - 3}
          y={props.y - 3}
          width={props.width + 6}
          height={nodeHeight + 6}
          rx={4}
          className="opacity-0 group-focus-visible:opacity-100"
          style={{ fill: "none", stroke: "var(--ring)", strokeWidth: 2 }}
        />
        {!isOuter && (
          // Middle labels sit over ribbons; a soft chip keeps them readable.
          <rect
            x={labelX - 4}
            y={centerY - LABEL_TOP}
            width={labelWidth + 8}
            height={LABEL_TOP + LABEL_BOTTOM}
            rx={6}
            style={{ fill: "var(--background)", fillOpacity: 0.86 }}
          />
        )}
        <text
          x={textX}
          y={centerY - 2}
          textAnchor={labelLeft ? "end" : "start"}
          className="text-[11px] font-medium"
          style={{ fill: "var(--foreground)" }}
        >
          {name}
        </text>
        <text
          x={textX}
          y={centerY + 11}
          textAnchor={labelLeft ? "end" : "start"}
          className="text-[10.5px] tabular-nums"
          style={{ fill: "var(--muted-foreground)" }}
        >
          {amount}
        </text>
      </g>
    );
  };

  const renderLink = (props: SankeyLinkProps) => {
    const source = props.payload.source as unknown as PositionedNode;
    const target = props.payload.target as unknown as PositionedNode;
    const lit = lineage == null || (lineage.has(source.id) && lineage.has(target.id));
    // Inflows describe their source, outflows their destination.
    const owner = target.kind === "total" ? source : target;
    const gradientId = `${uid}-link-${props.index}`;
    // A filled band rather than a wide stroke: a stroke thins and notches where
    // a thick ribbon bends steeply between close columns.
    const half = Math.max(props.linkWidth, 1) / 2;
    const { sourceX, sourceY, targetX, targetY, sourceControlX, targetControlX } = props;
    const d = [
      `M${sourceX},${sourceY - half}`,
      `C${sourceControlX},${sourceY - half} ${targetControlX},${targetY - half} ${targetX},${targetY - half}`,
      `L${targetX},${targetY + half}`,
      `C${targetControlX},${targetY + half} ${sourceControlX},${sourceY + half} ${sourceX},${sourceY + half}`,
      "Z",
    ].join(" ");

    return (
      <g key={`${source.id}-${target.id}`}>
        <defs>
          <linearGradient
            id={gradientId}
            gradientUnits="userSpaceOnUse"
            x1={props.sourceX}
            x2={props.targetX}
            y1={0}
            y2={0}
          >
            <stop offset="0%" style={{ stopColor: source.color }} />
            <stop offset="100%" style={{ stopColor: target.color }} />
          </linearGradient>
        </defs>
        <path
          d={d}
          style={{
            fill: `url(#${gradientId})`,
            fillOpacity: lineage == null ? "var(--mf-ribbon)" : lit ? "var(--mf-ribbon-lit)" : 0.07,
            transition: "fill-opacity 150ms ease",
          }}
          onMouseEnter={() =>
            activate({
              node: owner,
              x: owner.x + margin.left,
              y: owner.y + margin.top,
              width: owner.dx,
              height: owner.dy,
            })
          }
          onMouseLeave={() => activate(focused.current)}
        />
      </g>
    );
  };

  const moreColors = useMemo(
    () => [
      ...new Set(graph.nodes.filter((node) => node.kind === "more").map((node) => node.color)),
    ],
    [graph.nodes],
  );

  return (
    <div
      ref={chartRef}
      role="group"
      aria-label={t("spending:moneyFlow.chartLabel")}
      // Ribbons need more presence on dark surfaces.
      className="relative w-full [--mf-ribbon-lit:0.6] [--mf-ribbon:0.34] dark:[--mf-ribbon-lit:0.75] dark:[--mf-ribbon:0.46]"
      style={{ height }}
    >
      {/* Money enters on the left: reveal the chart in that direction. */}
      <motion.div
        className="size-full"
        initial={reduceMotion ? false : { clipPath: "inset(0 100% 0 0)" }}
        animate={{ clipPath: "inset(0 0% 0 0)" }}
        transition={{ duration: 0.9, ease: [0.22, 1, 0.36, 1] }}
      >
        <ResponsiveContainer
          width="100%"
          height="100%"
          onResize={(nextWidth) => setWidth(nextWidth)}
        >
          <Sankey
            data={data}
            nodeWidth={NODE_WIDTH}
            nodePadding={ROW_PITCH}
            sort={false}
            align="left"
            margin={margin}
            node={renderNode}
            link={renderLink}
          >
            <defs>
              {moreColors.map((color) => (
                <pattern
                  key={color}
                  id={`${uid}-stripe-${patternKey(color)}`}
                  width={6}
                  height={6}
                  patternTransform="rotate(45)"
                  patternUnits="userSpaceOnUse"
                >
                  <rect width={6} height={6} style={{ fill: color }} />
                  <rect width={3} height={6} style={{ fill: "var(--bar-stripe)" }} />
                </pattern>
              ))}
            </defs>
          </Sankey>
        </ResponsiveContainer>
      </motion.div>
      {active && (
        <MoneyFlowTooltip
          id={tooltipId}
          active={active}
          placeRight={active.node.column === 0 && lastColumn > 0}
          chartWidth={width}
          chartHeight={height}
          totals={graph.totals}
          currency={currency}
          canFocus={!!onFocusNode && isFocusable(active.node)}
        />
      )}
    </div>
  );
}

interface MoneyFlowTooltipProps {
  id: string;
  active: ActiveNode;
  placeRight: boolean;
  chartWidth: number;
  chartHeight: number;
  totals: MoneyFlowGraph["totals"];
  currency: string;
  canFocus: boolean;
}

function MoneyFlowTooltip({
  id,
  active,
  placeRight,
  chartWidth,
  chartHeight,
  totals,
  currency,
  canFocus,
}: MoneyFlowTooltipProps) {
  const { t } = useTranslation();
  const numberFormatting = useNumberFormatting();
  const { formatAmount } = useAmountFormatting();
  const { isBalanceHidden } = useBalancePrivacy();
  const { node } = active;
  // Beside the node, away from its label, and never past the chart's edges.
  const preferredLeft = placeRight
    ? active.x + active.width + LABEL_GAP * 2
    : active.x - LABEL_GAP * 2 - TOOLTIP_WIDTH;
  const left = Math.max(
    TOOLTIP_EDGE,
    Math.min(preferredLeft, chartWidth - TOOLTIP_WIDTH - TOOLTIP_EDGE),
  );
  // Grow away from the nearer horizontal edge, so a tall tooltip never spills out.
  const anchor = active.y + active.height / 2;
  const vertical =
    anchor < chartHeight / 2
      ? { top: Math.max(TOOLTIP_EDGE, anchor - TOOLTIP_ANCHOR_OFFSET) }
      : { bottom: Math.max(TOOLTIP_EDGE, chartHeight - anchor - TOOLTIP_ANCHOR_OFFSET) };
  const base = totals.income > 0 ? totals.income : totals.total;
  const share = base > 0 ? (node.value / base) * 100 : 0;
  // Without income the total is simply money out, before any refunds.
  const hintKey =
    node.kind === "total" && totals.income === 0
      ? "spending:moneyFlow.hint.totalOut"
      : HINT_KEYS[node.kind];
  const members = node.members ?? [];
  const hiddenMembers = Math.max(0, members.length - MAX_TOOLTIP_MEMBERS);

  return (
    <div
      id={id}
      role="tooltip"
      className="border-border/60 bg-popover text-popover-foreground pointer-events-none absolute z-10 w-60 rounded-xl border p-3 text-xs shadow-lg"
      style={{ left, ...vertical }}
    >
      <div className="flex items-center gap-2">
        <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: node.color }} />
        <span className="truncate font-medium">{node.name}</span>
      </div>
      <div className="mt-1.5 flex items-baseline justify-between gap-2">
        <span className="text-sm font-semibold tabular-nums">
          <PrivacyAmount value={node.value} currency={currency} />
        </span>
        {node.kind !== "total" && (
          <span className="text-muted-foreground tabular-nums">
            {t(
              totals.income > 0
                ? "spending:moneyFlow.shareOfIncome"
                : "spending:moneyFlow.shareOfTotal",
              { pct: formatPercentValue(share, numberFormatting, { digits: 0 }) },
            )}
          </span>
        )}
      </div>
      {hintKey && <p className="text-muted-foreground mt-1.5 leading-snug">{t(hintKey)}</p>}
      {node.netRefunds && (
        <p className="text-muted-foreground mt-1.5 leading-snug">
          {t("spending:moneyFlow.groupRefunds", {
            amount: isBalanceHidden ? "••••" : formatAmount(node.netRefunds, currency),
          })}
        </p>
      )}
      {members.length > 0 && (
        <ul className="border-border/50 mt-2 space-y-1 border-t pt-2">
          {members.slice(0, MAX_TOOLTIP_MEMBERS).map((member, index) => (
            <li key={index} className="flex justify-between gap-3">
              <span className="text-muted-foreground truncate">{member.name}</span>
              <span className="tabular-nums">
                <PrivacyAmount value={member.value} currency={currency} />
              </span>
            </li>
          ))}
          {hiddenMembers > 0 && (
            <li className="text-muted-foreground/70">
              {t("spending:whereIAm.moreCount", { count: hiddenMembers })}
            </li>
          )}
        </ul>
      )}
      {(node.categoryId || canFocus) && (
        <p className="text-muted-foreground/80 mt-2 text-[11px]">
          {t(
            node.categoryId
              ? "spending:moneyFlow.clickTransactions"
              : "spending:moneyFlow.clickCategories",
          )}
        </p>
      )}
    </div>
  );
}

/**
 * Nodes to keep lit while `id` is active: its upstream chain and downstream
 * subtree, stopping at the total so one income source doesn't light everything.
 * Activating the total itself lights the whole graph (`null`).
 */
function lineageOf(graph: MoneyFlowGraph, id: string): Set<string> | null {
  if (id === "total") return null;
  const lit = new Set([id]);
  const walk = (from: string, next: (nodeId: string) => string[]) => {
    const queue = [from];
    while (queue.length > 0) {
      const current = queue.pop()!;
      for (const neighbour of next(current)) {
        if (lit.has(neighbour)) continue;
        lit.add(neighbour);
        if (neighbour !== "total") queue.push(neighbour);
      }
    }
  };
  walk(id, (nodeId) => graph.links.filter((l) => l.target === nodeId).map((l) => l.source));
  walk(id, (nodeId) => graph.links.filter((l) => l.source === nodeId).map((l) => l.target));
  return lit;
}

function columnSizes(nodes: MoneyFlowNode[]): number[] {
  const sizes: number[] = [0];
  for (const node of nodes) sizes[node.column] = (sizes[node.column] ?? 0) + 1;
  return sizes;
}

/**
 * Measures label text in the page's own font, so truncation and label chips
 * fit the real glyphs under every theme. The canvas is created on first use
 * (only once nodes render), with an average-advance fallback without one.
 */
function useTextMeasure(): (text: string, font: LabelFont) => number {
  return useMemo(() => {
    let context: CanvasRenderingContext2D | null | undefined;
    let family = "";
    const cache = new Map<string, number>();
    return (text, font) => {
      if (context === undefined) {
        context = document.createElement("canvas").getContext("2d");
        family = getComputedStyle(document.body).fontFamily;
      }
      if (!context) return text.length * font.size * 0.56;
      const key = `${font.weight}|${font.size}|${text}`;
      let width = cache.get(key);
      if (width === undefined) {
        context.font = `${font.weight} ${font.size}px ${family}`;
        width = context.measureText(text).width;
        cache.set(key, width);
      }
      return width;
    };
  }, []);
}

const NAVIGATION_KEYS = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"]);

/**
 * Where an arrow key moves keyboard focus: along the column with Up/Down
 * (Home/End jump to its ends), and along the flow with Right (first child)
 * and Left (parent).
 */
function neighbourOf(
  graph: MoneyFlowGraph,
  node: MoneyFlowNode,
  key: string,
): MoneyFlowNode | undefined {
  const column = graph.nodes.filter((other) => other.column === node.column);
  const index = column.findIndex((other) => other.id === node.id);
  const byId = (id: string | undefined) => graph.nodes.find((other) => other.id === id);
  switch (key) {
    case "ArrowUp":
      return column[index - 1];
    case "ArrowDown":
      return column[index + 1];
    case "Home":
      return column[0];
    case "End":
      return column[column.length - 1];
    case "ArrowRight":
      return byId(graph.links.find((link) => link.source === node.id)?.target);
    case "ArrowLeft":
      return byId(graph.links.find((link) => link.target === node.id)?.source);
    default:
      return undefined;
  }
}

const graphemeSegmenter =
  typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;

function fitText(text: string, maxWidth: number, width: (text: string) => number): string {
  if (width(text) <= maxWidth) return text;
  // Cut between graphemes so an emoji (even a flag or ZWJ sequence) never splits.
  const chars = graphemeSegmenter
    ? Array.from(graphemeSegmenter.segment(text), (part) => part.segment)
    : Array.from(text);
  let end = chars.length - 1;
  while (end > 1 && width(`${chars.slice(0, end).join("")}…`) > maxWidth) end--;
  return `${chars.slice(0, end).join("").trimEnd()}…`;
}

/** Pattern ids must be valid fragment identifiers; colours may be `#hex` or `var(--x)`. */
function patternKey(color: string): string {
  return color.replace(/[^a-zA-Z0-9]/g, "");
}
