import { useAccountsSimplePerformance } from "@/hooks/use-accounts-simple-performance";
import type {
  Account,
  AccountValueSource,
  Holding,
  PortfolioAllocations,
  TaxonomyAllocation,
} from "@/lib/types";
import { cn } from "@/lib/utils";
import { Card, Icons, PrivacyAmount, Skeleton } from "@wealthfolio/ui";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  accountTreeWeights,
  buildBreakdownTree,
  currencyLensItems,
  OTHER_COLOR,
  toBreakdownNodes,
  type BreakdownNode,
} from "./allocation-derivations";

interface PortfolioExplorerProps {
  allocations?: PortfolioAllocations;
  holdings: Holding[];
  accounts: Account[];
  /** In-scope account ids — drives per-account valuations for the Accounts/Groups lenses. */
  accountIds?: string[];
  accountValuations?: AccountValueSource[];
  currency: string;
  isLoading?: boolean;
  onOpenAllocation: (allocation: TaxonomyAllocation, categoryId?: string) => void;
}

interface Lens {
  key: string;
  label: string;
  unit: string;
  nodes: BreakdownNode[];
  /** Taxonomy backing the lens; when present, leaf rows open the detail sheet. */
  allocation?: TaxonomyAllocation;
}

function sumOfCategories(allocation: TaxonomyAllocation | undefined): number {
  return (allocation?.categories ?? []).reduce((s, c) => s + (c.value > 0 ? c.value : 0), 0);
}

function sumValue(nodes: BreakdownNode[]): number {
  return nodes.reduce((s, n) => s + n.value, 0);
}

/** Collapse top-level nodes to top-N + an aggregated "Other" row (keeps children on the top-N). */
function collapseWeights(
  nodes: BreakdownNode[],
  topN: number,
  otherLabel: string,
): BreakdownNode[] {
  if (nodes.length <= topN + 1) return nodes;
  const top = nodes.slice(0, topN);
  const rest = nodes.slice(topN);
  return [
    ...top,
    {
      id: "__other__",
      name: otherLabel,
      value: rest.reduce((s, n) => s + n.value, 0),
      percentage: rest.reduce((s, n) => s + n.percentage, 0),
      color: OTHER_COLOR,
      depth: 0,
    },
  ];
}

function SegmentedBar({ nodes }: { nodes: BreakdownNode[] }) {
  return (
    <div className="bg-muted flex h-6 w-full overflow-hidden rounded-lg">
      {nodes.map((node, index) => (
        <div
          key={node.id}
          className="flex h-full items-center overflow-hidden px-2"
          style={{
            flex: `${Math.max(node.percentage, 0.5)} 1 0%`,
            background: node.color,
            boxShadow: index === 0 ? undefined : "inset 2px 0 0 var(--card)",
          }}
          title={`${node.name} · ${node.percentage.toFixed(1)}%`}
        >
          {node.percentage >= 8 && (
            <span className="truncate text-[10.5px] font-bold text-white/95">{node.name}</span>
          )}
        </div>
      ))}
    </div>
  );
}

function taxonomyLens(
  key: string,
  label: string,
  unit: string,
  allocation: TaxonomyAllocation | undefined,
): Lens {
  return {
    key,
    label,
    unit,
    nodes: buildBreakdownTree(allocation?.categories, sumOfCategories(allocation)),
    allocation,
  };
}

export function PortfolioExplorer({
  allocations,
  holdings,
  accounts,
  accountIds,
  accountValuations,
  currency,
  isLoading,
  onOpenAllocation,
}: PortfolioExplorerProps) {
  const { t } = useTranslation();
  const [activeKey, setActiveKey] = useState("allocation");
  const [showAll, setShowAll] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const scopedAccounts = useMemo(
    () => (accountIds ? accounts.filter((a) => accountIds.includes(a.id)) : accounts),
    [accounts, accountIds],
  );
  const { data: performance = [] } = useAccountsSimplePerformance(scopedAccounts, {
    enabled: accountValuations === undefined,
  });
  const accountValues = accountValuations ?? performance;

  const lenses = useMemo<Lens[]>(() => {
    const list: Lens[] = [
      taxonomyLens(
        "allocation",
        t("insights:insights.explorer.lens_allocation"),
        t("insights:insights.explorer.unit_categories"),
        allocations?.assetClasses,
      ),
      {
        key: "accounts",
        label: t("insights:insights.explorer.lens_accounts"),
        unit: t("insights:insights.explorer.unit_accounts"),
        nodes: accountTreeWeights(accountValues, scopedAccounts),
      },
      taxonomyLens(
        "sectors",
        t("insights:insights.explorer.lens_sectors"),
        t("insights:insights.explorer.unit_sectors"),
        allocations?.sectors,
      ),
      taxonomyLens(
        "regions",
        t("insights:insights.explorer.lens_regions"),
        t("insights:insights.explorer.unit_regions"),
        allocations?.regions,
      ),
      taxonomyLens(
        "risk",
        t("insights:insights.explorer.lens_risk"),
        t("insights:insights.explorer.unit_levels"),
        allocations?.riskCategory,
      ),
      taxonomyLens(
        "security",
        t("insights:insights.explorer.lens_security"),
        t("insights:insights.explorer.unit_types"),
        allocations?.securityTypes,
      ),
      {
        key: "currency",
        label: t("insights:insights.explorer.lens_currency"),
        unit: t("insights:insights.explorer.unit_currencies"),
        nodes: toBreakdownNodes(currencyLensItems(holdings)),
      },
    ];
    // Each custom-group taxonomy becomes its own lens.
    for (const taxonomy of allocations?.customGroups ?? []) {
      if (taxonomy.categories.some((c) => c.value > 0)) {
        list.push(
          taxonomyLens(
            taxonomy.taxonomyId,
            taxonomy.taxonomyName,
            t("insights:insights.explorer.unit_groups"),
            taxonomy,
          ),
        );
      }
    }
    return list;
  }, [allocations, holdings, scopedAccounts, accountValues, t]);

  const active = lenses.find((l) => l.key === activeKey) ?? lenses[0];

  function selectLens(key: string) {
    setActiveKey(key);
    setShowAll(false);
    setExpanded(new Set());
  }

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  if (isLoading) {
    return (
      <Card className="space-y-4 p-6">
        <Skeleton className="h-8 w-72" />
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-40 w-full" />
      </Card>
    );
  }

  const total = sumValue(active.nodes);
  const collapsible = active.nodes.length > 6;
  const otherLabel = t("insights:insights.explorer.other_units", { unit: active.unit });
  const barWeights = collapsible ? collapseWeights(active.nodes, 5, otherLabel) : active.nodes;
  const listWeights =
    collapsible && !showAll ? collapseWeights(active.nodes, 5, otherLabel) : active.nodes;

  function renderNode(node: BreakdownNode): React.ReactNode[] {
    const hasChildren = !!node.children?.length;
    const isOpen = expanded.has(node.id);
    const isOther = node.id === "__other__";
    const canOpenSheet = !hasChildren && !isOther && !!active.allocation;
    const interactive = hasChildren || canOpenSheet;
    const onActivate = hasChildren
      ? () => toggle(node.id)
      : canOpenSheet
        ? () => {
            if (active.allocation) onOpenAllocation(active.allocation, node.id);
          }
        : undefined;

    const row = (
      <div
        key={node.id}
        className={cn(
          "flex items-center gap-2 border-t py-2.5 first:border-t-0",
          interactive &&
            "hover:bg-muted/60 -mx-1.5 cursor-pointer rounded-lg px-1.5 transition-colors",
        )}
        style={{ paddingLeft: node.depth ? node.depth * 18 : undefined }}
        onClick={onActivate}
        role={interactive ? "button" : undefined}
        tabIndex={interactive ? 0 : undefined}
        onKeyDown={
          interactive
            ? (e) => {
                if (e.key === "Enter" || e.key === " ") onActivate?.();
              }
            : undefined
        }
      >
        <span className="flex min-w-0 flex-1 items-center gap-2">
          {hasChildren ? (
            <Icons.ChevronRight
              className={cn(
                "text-muted-foreground h-3.5 w-3.5 shrink-0 transition-transform",
                isOpen && "rotate-90",
              )}
            />
          ) : (
            <span className="w-3.5 shrink-0" />
          )}
          <span className="h-3 w-3 shrink-0 rounded-sm" style={{ background: node.color }} />
          <span
            className={cn(
              "truncate text-[13px]",
              node.depth ? "text-muted-foreground font-medium" : "text-foreground font-semibold",
              isOther && "text-muted-foreground font-medium",
            )}
          >
            {node.name}
          </span>
        </span>
        <span className="text-foreground w-[62px] text-right text-[13px] font-bold tabular-nums">
          {node.percentage.toFixed(1)}%
        </span>
        <span className="text-muted-foreground w-[84px] text-right text-[12px] tabular-nums">
          <PrivacyAmount value={node.value} currency={currency} />
        </span>
        <span className="text-muted-foreground w-3.5 text-center">
          {canOpenSheet ? <Icons.ChevronRight className="h-3.5 w-3.5" /> : null}
        </span>
      </div>
    );

    if (hasChildren && isOpen) {
      return [row, ...(node.children ?? []).flatMap((child) => renderNode(child))];
    }
    return [row];
  }

  return (
    <div>
      <div className="mb-2">
        <span className="text-muted-foreground text-sm font-medium uppercase tracking-wider">
          {t("insights:insights.explorer.breakdown")}
        </span>
      </div>

      <Card className="overflow-hidden p-0">
        {/* Lens tabs */}
        <div className="bg-muted/30 flex flex-wrap items-center gap-1 border-b px-3.5 py-2.5">
          {lenses.map((lens) => (
            <button
              key={lens.key}
              type="button"
              onClick={() => selectLens(lens.key)}
              className={cn(
                "rounded-lg px-4 py-2 text-[13px] transition-colors",
                lens.key === active.key
                  ? "bg-foreground text-background font-semibold"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
            >
              {lens.label}
            </button>
          ))}
        </div>

        {/* Full-width breakdown */}
        <div className="p-6">
          <div className="mb-3.5 flex items-baseline justify-between gap-3.5">
            <span className="text-[13.5px] font-bold">{active.label}</span>
            <span className="text-muted-foreground text-[12.5px] tabular-nums">
              <PrivacyAmount value={total} currency={currency} /> · {active.nodes.length}{" "}
              {active.unit}
            </span>
          </div>
          <SegmentedBar nodes={barWeights} />
          <div className="mb-1 mt-4 flex items-baseline justify-between">
            <span className="text-muted-foreground text-[10.5px] font-semibold uppercase tracking-wider">
              {collapsible && !showAll
                ? t("insights:insights.explorer.top_units", { unit: active.unit })
                : active.label}
            </span>
            {collapsible && (
              <button
                type="button"
                onClick={() => setShowAll((v) => !v)}
                className="text-muted-foreground hover:text-foreground text-[12px] font-semibold"
              >
                {showAll
                  ? t("insights:insights.explorer.show_less")
                  : t("insights:insights.explorer.show_all")}
              </button>
            )}
          </div>
          <div>{listWeights.flatMap((node) => renderNode(node))}</div>
        </div>
      </Card>
    </div>
  );
}
