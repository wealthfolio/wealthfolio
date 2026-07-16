import { memo, useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { Icons, PrivacyAmount, Skeleton } from "@wealthfolio/ui";
import { useIsMobileViewport } from "@/hooks/use-platform";
import type { TaxonomyCategory } from "@/lib/types";
import { cn } from "@/lib/utils";

import { CategoryIcon } from "../category-chips";
import type { BudgetCategoryRow, BudgetGroupRow } from "../../types/budget";
import type { CategoryBreakdownRow } from "../../types/report";
import {
  buildGroupWeights,
  buildTree,
  formatDelta,
  type CategorySort,
  type GroupNode,
  type NodeRow,
} from "./category-hierarchy/builders";

export type { CategorySort };

interface CategoryHierarchyTableProps {
  /** Spending breakdown for the current period (flat rows from backend). */
  breakdown: CategoryBreakdownRow[];
  /** Prior-period breakdown — drives the Δ column. */
  priorBreakdown: CategoryBreakdownRow[];
  /** Backend-computed category budget rows. */
  budgetRows: BudgetCategoryRow[];
  /**
   * Budget groups (Needs / Wants / ...). When present, the table renders a
   * group-level wrapper above categories. When empty / undefined, the table
   * falls back to the original 2-level (category → subcategory) layout.
   */
  groupRows?: BudgetGroupRow[];
  /** Taxonomy metadata (used to resolve names + parent ids). */
  taxonomyCategories: TaxonomyCategory[];
  currency: string;
  isLoading: boolean;
  /** Sort order for top-level rows. Defaults to "spent" (largest first). */
  sort?: CategorySort;
  /** Fired when a category row is clicked (excluding the parent expand chevron). */
  onCategoryClick?: (categoryId: string) => void;
}

/**
 * Hierarchical Budgeted / Spent / Balance / Δ table.
 *
 * Without `groupRows`: rolls flat backend rows into a top-level → subcategory
 * tree using the taxonomy `parentId` graph.
 *
 * With `groupRows`: wraps the same tree in budget groups (Needs / Wants / …),
 * with a synthetic "Other" group catching categories that aren't assigned to
 * any group.
 */
export function CategoryHierarchyTable({
  breakdown,
  priorBreakdown,
  budgetRows,
  groupRows,
  taxonomyCategories,
  currency,
  isLoading,
  sort = "spent",
  onCategoryClick,
}: CategoryHierarchyTableProps) {
  const { t: tr } = useTranslation();
  const isMobile = useIsMobileViewport();
  const tree = useMemo(
    () => buildTree({ breakdown, priorBreakdown, budgetRows, taxonomyCategories, sort }),
    [breakdown, priorBreakdown, budgetRows, taxonomyCategories, sort],
  );

  const totals = useMemo(() => {
    const t = { budgeted: 0, spent: 0, priorSpent: 0 };
    for (const node of tree) {
      t.budgeted += node.budgeted;
      t.spent += node.spent;
      t.priorSpent += node.priorSpent;
    }
    return t;
  }, [tree]);

  const groups = useMemo(
    () =>
      groupRows && groupRows.length > 0 ? buildGroupWeights({ tree, groupRows, budgetRows }) : null,
    [tree, groupRows, budgetRows],
  );

  // Expand state for groups + categories lives here so the "Expand all /
  // Collapse all" toggle can flip everything at once. Keys are group ids
  // and category ids (no collision — different id spaces). Groups default
  // to expanded; categories stay collapsed until the user opens them.
  const expandableGroupIds = useMemo(
    () => (groups ?? []).filter((g) => g.children.length > 0).map((g) => g.id),
    [groups],
  );
  const expandableCategoryIds = useMemo(() => {
    const ids: string[] = [];
    if (groups) {
      for (const g of groups) {
        for (const node of g.children) if (node.children.length > 0) ids.push(node.id);
      }
    } else {
      for (const node of tree) if (node.children.length > 0) ids.push(node.id);
    }
    return ids;
  }, [groups, tree]);

  const [expandedById, setExpandedById] = useState<Record<string, boolean>>({});
  // Re-seed when the set of expandable ids changes (groups default open,
  // categories closed); preserve any user toggles. Done during render per
  // React docs guidance to avoid an extra render from useEffect.
  const expandableIdsKey = expandableGroupIds.join(",") + "|" + expandableCategoryIds.join(",");
  const [lastIdsKey, setLastIdsKey] = useState(expandableIdsKey);
  if (expandableIdsKey !== lastIdsKey) {
    setLastIdsKey(expandableIdsKey);
    setExpandedById((prev) => {
      const next: Record<string, boolean> = {};
      for (const id of expandableGroupIds) next[id] = prev[id] ?? true;
      for (const id of expandableCategoryIds) next[id] = prev[id] ?? false;
      return next;
    });
  }

  const hasExpandable = expandableGroupIds.length + expandableCategoryIds.length > 0;
  const allExpanded =
    hasExpandable &&
    expandableGroupIds.every((id) => expandedById[id]) &&
    expandableCategoryIds.every((id) => expandedById[id]);
  const toggleAll = () => {
    const target = !allExpanded;
    const next: Record<string, boolean> = {};
    for (const id of expandableGroupIds) next[id] = target;
    for (const id of expandableCategoryIds) next[id] = target;
    setExpandedById(next);
  };
  const setRowExpanded = useCallback(
    (id: string, value: boolean) => setExpandedById((prev) => ({ ...prev, [id]: value })),
    [],
  );

  if (isLoading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-9 w-full" />
        ))}
      </div>
    );
  }

  if (tree.length === 0) {
    return (
      <div className="text-muted-foreground py-8 text-center text-sm">
        {tr("spending:hierarchy.noCategorizedSpending")}
      </div>
    );
  }

  if (isMobile) {
    return (
      <div className="text-foreground">
        <ul className="space-y-1.5">
          {groups
            ? groups.map((group) => (
                <MobileGroupRow
                  key={group.id}
                  group={group}
                  currency={currency}
                  onCategoryClick={onCategoryClick}
                  expanded={!!expandedById[group.id]}
                  onToggle={() => setRowExpanded(group.id, !expandedById[group.id])}
                  expandedById={expandedById}
                  onChildToggle={setRowExpanded}
                />
              ))
            : tree.map((node) => (
                <MobileCategoryRow
                  key={node.id}
                  node={node}
                  currency={currency}
                  onCategoryClick={onCategoryClick}
                  expanded={!!expandedById[node.id]}
                  onToggle={() => setRowExpanded(node.id, !expandedById[node.id])}
                  standalone
                />
              ))}
        </ul>
        <div className="mt-4">
          <div className="border-border/30 flex items-baseline justify-between gap-3 border-t pt-4">
            <span className="text-muted-foreground/80 text-[10px] font-semibold uppercase tracking-[0.14em]">
              {tr("spending:hierarchy.totalSpent")}
            </span>
            <span className="text-foreground text-xl font-semibold tabular-nums tracking-tight">
              <PrivacyAmount value={totals.spent} currency={currency} />
            </span>
          </div>
          {totals.budgeted > 0 && (
            <div className="text-muted-foreground/60 mt-0.5 text-right text-[11px] tabular-nums">
              {tr("spending:hierarchy.of")}{" "}
              <PrivacyAmount value={totals.budgeted} currency={currency} />{" "}
              {tr("spending:hierarchy.budgeted")}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="text-foreground w-full text-sm">
        <thead>
          <tr className="border-border/60 text-muted-foreground/80 border-b text-[11px] uppercase tracking-wide">
            <th className="px-3 py-2 text-left font-medium">
              <div className="flex items-center gap-3">
                <span>{tr("spending:filters.category")}</span>
                {hasExpandable && (
                  <button
                    type="button"
                    onClick={toggleAll}
                    aria-pressed={allExpanded}
                    className="text-muted-foreground hover:text-foreground hover:bg-muted/60 -my-1 inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-medium normal-case tracking-normal transition-colors"
                    title={
                      allExpanded
                        ? tr("spending:hierarchy.collapseAllRows")
                        : tr("spending:hierarchy.expandAllRows")
                    }
                  >
                    <Icons.ChevronsUpDown
                      className={cn("h-3 w-3 transition-transform", allExpanded && "rotate-180")}
                      aria-hidden
                    />
                    {allExpanded
                      ? tr("spending:hierarchy.collapseAll")
                      : tr("spending:hierarchy.expandAll")}
                  </button>
                )}
              </div>
            </th>
            <th className="px-3 py-2 text-right font-medium">
              {tr("spending:hierarchy.spentBudget")}
            </th>
            <th className="px-3 py-2 text-left font-medium">{tr("spending:hierarchy.progress")}</th>
            <th className="px-3 py-2 text-right font-medium">
              {tr("spending:hierarchy.deltaVsPrior")}
            </th>
          </tr>
        </thead>
        <tbody>
          {groups
            ? groups.map((group) => (
                <GroupRow
                  key={group.id}
                  group={group}
                  totalSpent={totals.spent}
                  currency={currency}
                  onCategoryClick={onCategoryClick}
                  expanded={!!expandedById[group.id]}
                  onToggle={() => setRowExpanded(group.id, !expandedById[group.id])}
                  expandedById={expandedById}
                  onChildToggle={setRowExpanded}
                />
              ))
            : tree.map((node) => (
                <ParentRow
                  key={node.id}
                  node={node}
                  currency={currency}
                  onCategoryClick={onCategoryClick}
                  expanded={!!expandedById[node.id]}
                  onToggle={() => setRowExpanded(node.id, !expandedById[node.id])}
                />
              ))}
        </tbody>
        <tfoot>
          <tr className="border-border/60 border-t text-sm font-medium">
            <td className="px-3 py-2.5">{tr("spending:hierarchy.total")}</td>
            <td className="px-3 py-2.5 text-right text-xs tabular-nums">
              <span className="text-foreground font-medium">
                <PrivacyAmount value={totals.spent} currency={currency} />
              </span>
              {totals.budgeted > 0 && (
                <span className="text-muted-foreground/70 ml-1">
                  / <PrivacyAmount value={totals.budgeted} currency={currency} />
                </span>
              )}
            </td>
            <td className="px-3 py-2.5">
              {totals.budgeted > 0 ? (
                <ProgressBar spent={totals.spent} budget={totals.budgeted} />
              ) : (
                <span className="text-muted-foreground/50 text-xs">
                  {tr("spending:hierarchy.noBudgetSet")}
                </span>
              )}
            </td>
            <td
              className={cn(
                "px-3 py-2.5 text-right text-xs tabular-nums",
                totals.priorSpent === 0 || totals.spent - totals.priorSpent === 0
                  ? "text-muted-foreground/70"
                  : totals.spent - totals.priorSpent > 0
                    ? "text-destructive"
                    : "text-success",
              )}
            >
              {formatDelta(totals.spent - totals.priorSpent, totals.priorSpent)}
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function ProgressBar({ spent, budget }: { spent: number; budget: number }) {
  if (budget <= 0) return null;
  const pct = (spent / budget) * 100;
  const isOver = pct > 100;
  const isClose = pct >= 85 && !isOver;
  const fillColor = isOver
    ? "var(--destructive)"
    : isClose
      ? "var(--status-warn)"
      : "var(--success)";
  return (
    <div className="flex items-center gap-2">
      <div className="bg-foreground/10 relative h-1.5 min-w-[60px] flex-1 overflow-hidden rounded-full">
        <div
          className="h-full rounded-full transition-all"
          style={{ width: `${Math.min(100, pct)}%`, backgroundColor: fillColor, opacity: 0.65 }}
        />
      </div>
      <span
        className={cn(
          "w-10 shrink-0 text-right text-[11px] tabular-nums",
          isOver ? "text-destructive font-medium" : "text-muted-foreground/80",
        )}
      >
        {pct.toFixed(0)}%
      </span>
    </div>
  );
}

const GroupRow = memo(function GroupRow({
  group,
  totalSpent,
  currency,
  onCategoryClick,
  expanded,
  onToggle,
  expandedById,
  onChildToggle,
}: {
  group: GroupNode;
  totalSpent: number;
  currency: string;
  onCategoryClick?: (categoryId: string) => void;
  expanded: boolean;
  onToggle: () => void;
  expandedById: Record<string, boolean>;
  onChildToggle: (id: string, value: boolean) => void;
}) {
  const hasChildren = group.children.length > 0;
  const delta = group.spent - group.priorSpent;
  const sharePct = totalSpent > 0 ? (group.spent / totalSpent) * 100 : 0;
  const accent = group.color ?? "var(--muted-foreground)";

  return (
    <>
      <tr
        className={cn(
          "border-border/60 bg-muted/20 hover:bg-muted/30 border-b border-t-0",
          hasChildren && "cursor-pointer",
        )}
        onClick={hasChildren ? onToggle : undefined}
      >
        <td className="px-3 py-2.5">
          <div className="flex items-center gap-2">
            <Icons.ChevronRight
              className={cn(
                "text-muted-foreground/70 h-3.5 w-3.5 transition-transform",
                expanded && "rotate-90",
                !hasChildren && "opacity-0",
              )}
            />
            <span
              className="block h-2 w-2 shrink-0 rounded-full"
              style={{ backgroundColor: accent }}
            />
            <span className="text-foreground text-sm font-semibold uppercase tracking-wide">
              {group.name}
            </span>
            <span className="text-muted-foreground/70 text-[11px] font-medium tabular-nums">
              {sharePct.toFixed(1)}%
            </span>
          </div>
        </td>
        <td className="text-foreground px-3 py-2.5 text-right text-xs font-semibold tabular-nums">
          <PrivacyAmount value={group.spent} currency={currency} />
          {group.budgeted > 0 && (
            <span className="text-muted-foreground/70 ml-1 font-normal">
              / <PrivacyAmount value={group.budgeted} currency={currency} />
            </span>
          )}
        </td>
        <td className="px-3 py-2.5">
          {group.budgeted > 0 ? (
            <ProgressBar spent={group.spent} budget={group.budgeted} />
          ) : (
            <span className="text-muted-foreground/50 text-xs">—</span>
          )}
        </td>
        <td
          className={cn(
            "px-3 py-2.5 text-right text-xs font-medium tabular-nums",
            delta === 0 || group.priorSpent === 0
              ? "text-muted-foreground/70"
              : delta > 0
                ? "text-destructive"
                : "text-success",
          )}
        >
          {formatDelta(delta, group.priorSpent)}
        </td>
      </tr>
      {expanded &&
        group.children.map((node) => (
          <ParentRow
            key={node.id}
            node={node}
            currency={currency}
            onCategoryClick={onCategoryClick}
            indented
            expanded={!!expandedById[node.id]}
            onToggle={() => onChildToggle(node.id, !expandedById[node.id])}
          />
        ))}
    </>
  );
});

const ParentRow = memo(function ParentRow({
  node,
  currency,
  onCategoryClick,
  indented = false,
  expanded,
  onToggle,
}: {
  node: NodeRow;
  currency: string;
  onCategoryClick?: (categoryId: string) => void;
  /** Nested under a group — adds left padding so the category column aligns. */
  indented?: boolean;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const hasChildren = node.children.length > 0;
  const delta = node.spent - node.priorSpent;
  const accent = node.color ?? "var(--muted-foreground)";
  const tintBg = node.color ? `${node.color}1F` : "var(--muted)";
  const clickable = !!onCategoryClick;

  return (
    <>
      <tr
        className={cn(
          "border-border/40 hover:bg-muted/30 group border-b",
          clickable && "cursor-pointer",
        )}
        onClick={clickable ? () => onCategoryClick?.(node.id) : undefined}
      >
        <td className="px-3 py-2.5">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onToggle();
              }}
              className="text-muted-foreground/70 hover:text-foreground -m-1 flex h-5 w-5 items-center justify-center rounded p-1"
              aria-expanded={expanded}
              aria-label={hasChildren ? t("spending:hierarchy.toggleSubcategories") : undefined}
              disabled={!hasChildren}
            >
              <Icons.ChevronRight
                className={cn(
                  "h-3.5 w-3.5 transition-transform",
                  expanded && "rotate-90",
                  !hasChildren && "opacity-0",
                )}
              />
            </button>
            <span
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full"
              style={{ backgroundColor: tintBg, color: accent }}
            >
              <CategoryIcon icon={node.icon} fallback={node.name} className="h-3.5 w-3.5" />
            </span>
            <span className="text-foreground text-sm font-medium">{node.name}</span>
          </div>
        </td>
        <td className="text-foreground/90 px-3 py-2.5 text-right text-xs tabular-nums">
          <span className="text-foreground font-medium">
            <PrivacyAmount value={node.spent} currency={currency} />
          </span>
          {node.budgeted > 0 && (
            <span className="text-muted-foreground/70 ml-1">
              / <PrivacyAmount value={node.budgeted} currency={currency} />
            </span>
          )}
        </td>
        <td className="px-3 py-2.5">
          {node.budgeted > 0 ? (
            <ProgressBar spent={node.spent} budget={node.budgeted} />
          ) : (
            <span className="text-muted-foreground/50 text-xs">
              {t("spending:hierarchy.noBudgetSet")}
            </span>
          )}
        </td>
        <td
          className={cn(
            "px-3 py-2.5 text-right text-xs tabular-nums",
            delta === 0 || node.priorSpent === 0
              ? "text-muted-foreground/70"
              : delta > 0
                ? "text-destructive"
                : "text-success",
          )}
        >
          {formatDelta(delta, node.priorSpent)}
        </td>
      </tr>
      {expanded &&
        node.children.map((child) => (
          <ChildRow
            key={child.id}
            node={child}
            currency={currency}
            parentColor={accent}
            onCategoryClick={onCategoryClick}
            indented={indented}
          />
        ))}
    </>
  );
});

const ChildRow = memo(function ChildRow({
  node,
  currency,
  parentColor,
  onCategoryClick,
  indented = false,
}: {
  node: NodeRow;
  currency: string;
  parentColor: string;
  onCategoryClick?: (categoryId: string) => void;
  indented?: boolean;
}) {
  const delta = node.spent - node.priorSpent;
  const clickable = !!onCategoryClick;
  return (
    <tr
      className={cn(
        "border-border/30 hover:bg-muted/20 border-b text-[13px]",
        clickable && "cursor-pointer",
      )}
      onClick={clickable ? () => onCategoryClick?.(node.id) : undefined}
    >
      <td className={cn("text-muted-foreground/90 px-3 py-1.5 pl-9", indented && "pl-14")}>
        <div className="flex items-center gap-2">
          <span
            className="h-1 w-1 shrink-0 rounded-full"
            style={{ backgroundColor: parentColor, opacity: 0.6 }}
          />
          <span>{node.name}</span>
        </div>
      </td>
      <td className="text-muted-foreground/90 px-3 py-1.5 text-right text-xs tabular-nums">
        <PrivacyAmount value={node.spent} currency={currency} />
      </td>
      <td className="px-3 py-1.5"></td>
      <td
        className={cn(
          "px-3 py-1.5 text-right text-xs tabular-nums",
          delta === 0 || node.priorSpent === 0
            ? "text-muted-foreground/60"
            : delta > 0
              ? "text-destructive"
              : "text-success",
        )}
      >
        {formatDelta(delta, node.priorSpent)}
      </td>
    </tr>
  );
});

function DeltaPill({ delta, priorSpent }: { delta: number; priorSpent: number }) {
  if (priorSpent === 0 || delta === 0) {
    return (
      <span className="text-muted-foreground/60 shrink-0 text-[11px] tabular-nums">
        {formatDelta(delta, priorSpent)}
      </span>
    );
  }
  const up = delta > 0;
  return (
    <span
      className={cn(
        "shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium tabular-nums",
        up ? "bg-destructive/10 text-destructive" : "bg-success/10 text-success",
      )}
    >
      {formatDelta(delta, priorSpent)}
    </span>
  );
}

const MOBILE_CARD = "border-border/40 bg-card/40 rounded-2xl border";

const MobileGroupRow = memo(function MobileGroupRow({
  group,
  currency,
  onCategoryClick,
  expanded,
  onToggle,
  expandedById,
  onChildToggle,
}: {
  group: GroupNode;
  currency: string;
  onCategoryClick?: (categoryId: string) => void;
  expanded: boolean;
  onToggle: () => void;
  expandedById: Record<string, boolean>;
  onChildToggle: (id: string, value: boolean) => void;
}) {
  const { t } = useTranslation();
  const hasChildren = group.children.length > 0;
  const hasBudget = group.budgeted > 0;
  const delta = group.spent - group.priorSpent;
  const accent = group.color ?? "var(--muted-foreground)";

  // Empty group — single-line card.
  if (!hasChildren && !hasBudget) {
    return (
      <li className={cn(MOBILE_CARD, "flex items-center gap-2.5 px-4 py-3")}>
        <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: accent }} />
        <span className="text-foreground/75 flex-1 truncate text-[10.5px] font-semibold uppercase tracking-[0.14em]">
          {group.name}
        </span>
        <span className="text-foreground/90 shrink-0 text-sm font-medium tabular-nums">
          <PrivacyAmount value={group.spent} currency={currency} />
        </span>
        <DeltaPill delta={delta} priorSpent={group.priorSpent} />
      </li>
    );
  }

  return (
    <li className={MOBILE_CARD}>
      <button
        type="button"
        className="hover:bg-muted/20 block w-full rounded-2xl px-4 pb-3 pt-3 text-left transition-colors"
        onClick={hasChildren ? onToggle : undefined}
        disabled={!hasChildren}
      >
        <div className="flex items-center gap-2.5">
          <span
            className="block h-1.5 w-1.5 shrink-0 rounded-full"
            style={{ backgroundColor: accent }}
          />
          <span className="text-foreground/75 flex-1 truncate text-[10.5px] font-semibold uppercase tracking-[0.14em]">
            {group.name}
          </span>
          <DeltaPill delta={delta} priorSpent={group.priorSpent} />
          {hasChildren && (
            <Icons.ChevronRight
              className={cn(
                "text-muted-foreground/40 h-3.5 w-3.5 shrink-0 transition-transform",
                expanded && "rotate-90",
              )}
            />
          )}
        </div>
        <div className="mt-1.5 flex items-baseline justify-between gap-3 pl-4">
          <span className="text-foreground text-[15px] font-semibold tabular-nums tracking-tight">
            <PrivacyAmount value={group.spent} currency={currency} />
          </span>
          {hasBudget && (
            <span className="text-muted-foreground/60 shrink-0 text-[11px] tabular-nums">
              {t("spending:hierarchy.of")}{" "}
              <PrivacyAmount value={group.budgeted} currency={currency} />
            </span>
          )}
        </div>
        {hasBudget && (
          <div className="mt-1.5 pl-4">
            <ProgressBar spent={group.spent} budget={group.budgeted} />
          </div>
        )}
      </button>
      {expanded && hasChildren && (
        <ul className="border-border/30 mx-4 mt-1 space-y-1 border-t pb-3 pt-2">
          {group.children.map((node) => (
            <MobileCategoryRow
              key={node.id}
              node={node}
              currency={currency}
              onCategoryClick={onCategoryClick}
              expanded={!!expandedById[node.id]}
              onToggle={() => onChildToggle(node.id, !expandedById[node.id])}
            />
          ))}
        </ul>
      )}
    </li>
  );
});

const MobileCategoryRow = memo(function MobileCategoryRow({
  node,
  currency,
  onCategoryClick,
  expanded,
  onToggle,
  standalone = false,
}: {
  node: NodeRow;
  currency: string;
  onCategoryClick?: (categoryId: string) => void;
  expanded: boolean;
  onToggle: () => void;
  /** Render as a standalone card (no enclosing group). */
  standalone?: boolean;
}) {
  const { t } = useTranslation();
  const hasChildren = node.children.length > 0;
  const hasBudget = node.budgeted > 0;
  const delta = node.spent - node.priorSpent;
  const accent = node.color ?? "var(--muted-foreground)";
  const tintBg = node.color ? `${node.color}1F` : "var(--muted)";
  const clickable = !!onCategoryClick;

  const pct = hasBudget ? (node.spent / node.budgeted) * 100 : 0;
  const subtitle = hasBudget ? (
    <>
      <span className={cn("tabular-nums", pct > 100 ? "text-destructive" : undefined)}>
        {pct.toFixed(0)}%
      </span>
      <span className="text-muted-foreground/50"> · {t("spending:hierarchy.of")} </span>
      <PrivacyAmount value={node.budgeted} currency={currency} />
    </>
  ) : null;

  return (
    <li className={cn(standalone && MOBILE_CARD)}>
      <div
        className={cn(
          "flex items-center gap-3 rounded-xl transition-colors",
          standalone ? "px-4 py-3" : "py-2",
          clickable && "hover:bg-muted/30 cursor-pointer",
        )}
        onClick={clickable ? () => onCategoryClick?.(node.id) : undefined}
      >
        <span
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl"
          style={{ backgroundColor: tintBg, color: accent }}
          aria-hidden
        >
          <CategoryIcon icon={node.icon} fallback={node.name} className="h-[18px] w-[18px]" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-foreground truncate text-sm font-semibold">{node.name}</div>
          {subtitle && (
            <div className="text-muted-foreground/70 mt-0.5 truncate text-[11px] tabular-nums">
              {subtitle}
            </div>
          )}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-0.5">
          <span className="text-foreground text-sm font-semibold tabular-nums">
            <PrivacyAmount value={node.spent} currency={currency} />
          </span>
          <DeltaPill delta={delta} priorSpent={node.priorSpent} />
        </div>
        {hasChildren && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onToggle();
            }}
            className="text-muted-foreground/40 hover:text-foreground -m-1 flex h-6 w-6 shrink-0 items-center justify-center rounded p-1"
            aria-expanded={expanded}
            aria-label={t("spending:hierarchy.toggleSubcategories")}
          >
            <Icons.ChevronDown
              className={cn("h-3.5 w-3.5 transition-transform", expanded && "rotate-180")}
            />
          </button>
        )}
      </div>
      {expanded && hasChildren && (
        <ul
          className={cn(
            "border-border/30 divide-border/30 mt-1 divide-y border-t pt-1",
            standalone ? "mx-4 mb-3" : "ml-[52px]",
          )}
        >
          {node.children.map((child) => (
            <MobileSubcategoryRow
              key={child.id}
              node={child}
              currency={currency}
              parentColor={accent}
              onCategoryClick={onCategoryClick}
            />
          ))}
        </ul>
      )}
    </li>
  );
});

function MobileSubcategoryRow({
  node,
  currency,
  parentColor,
  onCategoryClick,
}: {
  node: NodeRow;
  currency: string;
  parentColor: string;
  onCategoryClick?: (categoryId: string) => void;
}) {
  const delta = node.spent - node.priorSpent;
  const clickable = !!onCategoryClick;
  return (
    <li
      className={cn(
        "hover:bg-muted/20 flex items-center gap-2 py-1.5 text-[13px] transition-colors",
        clickable && "cursor-pointer",
      )}
      onClick={clickable ? () => onCategoryClick?.(node.id) : undefined}
    >
      <span
        className="h-1.5 w-1.5 shrink-0 rounded-full"
        style={{ backgroundColor: parentColor, opacity: 0.6 }}
      />
      <span className="text-muted-foreground/90 flex-1 truncate">{node.name}</span>
      <DeltaPill delta={delta} priorSpent={node.priorSpent} />
      <span className="text-muted-foreground/90 shrink-0 text-xs tabular-nums">
        <PrivacyAmount value={node.spent} currency={currency} />
      </span>
    </li>
  );
}
