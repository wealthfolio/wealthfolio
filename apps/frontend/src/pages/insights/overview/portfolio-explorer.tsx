import { useI18n } from "@/i18n/i18n-provider";
import { translateClassificationLabel } from "@/i18n/ui-text";
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
  localizedLabel: string;
  unit: string;
  unitLabel: string;
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
  const { language } = useI18n();
  return (
    <div className="bg-muted flex h-6 w-full overflow-hidden rounded-lg">
      {nodes.map((node, index) => {
        const name = translateClassificationLabel(language, node.name);
        return (
          <div
            key={node.id}
            className="flex h-full items-center overflow-hidden px-2"
            style={{
              flex: `${Math.max(node.percentage, 0.5)} 1 0%`,
              background: node.color,
              boxShadow: index === 0 ? undefined : "inset 2px 0 0 var(--card)",
            }}
            title={`${name} · ${node.percentage.toFixed(1)}%`}
          >
            {node.percentage >= 8 && (
              <span className="truncate text-[10.5px] font-bold text-white/95">{name}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

function taxonomyLens(
  key: string,
  label: string,
  localizedLabel: string,
  unit: string,
  unitLabel: string,
  allocation: TaxonomyAllocation | undefined,
): Lens {
  return {
    key,
    label,
    localizedLabel,
    unit,
    unitLabel,
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
  const { language } = useI18n();
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
        "Allocation",
        "配置",
        "categories",
        "分类",
        allocations?.assetClasses,
      ),
      {
        key: "accounts",
        label: "Accounts",
        localizedLabel: "账户",
        unit: "accounts",
        unitLabel: "账户",
        nodes: accountTreeWeights(accountValues, scopedAccounts),
      },
      taxonomyLens("sectors", "Sectors", "行业", "sectors", "行业", allocations?.sectors),
      taxonomyLens("regions", "Regions", "地区", "regions", "地区", allocations?.regions),
      taxonomyLens("risk", "Risk", "风险", "levels", "等级", allocations?.riskCategory),
      taxonomyLens(
        "security",
        "Security types",
        "证券类型",
        "types",
        "类型",
        allocations?.securityTypes,
      ),
      {
        key: "currency",
        label: "Currency",
        localizedLabel: "币种",
        unit: "currencies",
        unitLabel: "币种",
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
            taxonomy.taxonomyName,
            "groups",
            "分组",
            taxonomy,
          ),
        );
      }
    }
    return list;
  }, [allocations, holdings, scopedAccounts, accountValues]);

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
  const activeLabel = language === "zh-CN" ? active.localizedLabel : active.label;
  const otherLabel = language === "zh-CN" ? `其他${active.unitLabel}` : `Other ${active.unit}`;
  const countLabel = language === "zh-CN" ? `个${active.unitLabel}` : active.unit;
  const topLabel = language === "zh-CN" ? `主要${active.unitLabel}` : `Top ${active.unit}`;
  const barWeights = collapsible
    ? collapseWeights(active.nodes, 5, otherLabel)
    : active.nodes;
  const listWeights =
    collapsible && !showAll
      ? collapseWeights(active.nodes, 5, otherLabel)
      : active.nodes;

  function renderNode(node: BreakdownNode): React.ReactNode[] {
    const hasChildren = !!node.children?.length;
    const isOpen = expanded.has(node.id);
    const isOther = node.id === "__other__";
    const nodeName = translateClassificationLabel(language, node.name);
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
            {nodeName}
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
          {language === "zh-CN" ? "配置明细" : "Breakdown"}
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
              {language === "zh-CN" ? lens.localizedLabel : lens.label}
            </button>
          ))}
        </div>

        {/* Full-width breakdown */}
        <div className="p-6">
          <div className="mb-3.5 flex items-baseline justify-between gap-3.5">
            <span className="text-[13.5px] font-bold">{activeLabel}</span>
            <span className="text-muted-foreground text-[12.5px] tabular-nums">
              <PrivacyAmount value={total} currency={currency} /> · {active.nodes.length}{" "}
              {countLabel}
            </span>
          </div>
          <SegmentedBar nodes={barWeights} />
          <div className="mb-1 mt-4 flex items-baseline justify-between">
            <span className="text-muted-foreground text-[10.5px] font-semibold uppercase tracking-wider">
              {collapsible && !showAll ? topLabel : activeLabel}
            </span>
            {collapsible && (
              <button
                type="button"
                onClick={() => setShowAll((v) => !v)}
                className="text-muted-foreground hover:text-foreground text-[12px] font-semibold"
              >
                {showAll
                  ? language === "zh-CN"
                    ? "收起"
                    : "Show less"
                  : language === "zh-CN"
                    ? "显示全部"
                    : "Show all"}
              </button>
            )}
          </div>
          <div>{listWeights.flatMap((node) => renderNode(node))}</div>
        </div>
      </Card>
    </div>
  );
}
