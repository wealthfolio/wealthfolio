import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import type { TaxonomyCategory } from "@/lib/types";
import { Button, Icons, Skeleton } from "@wealthfolio/ui";

import {
  buildMoneyFlowGraph,
  focusMoneyFlowGraph,
  moneyFlowInputFromReport,
} from "../../../lib/money-flow";
import type { BudgetSnapshot } from "../../../types/budget";
import type { MonthlyReport } from "../../../types/report";
import { MoneyFlowChart } from "./money-flow-chart";

/** Zoomed views show every category and income source; nothing folds into "+N more". */
const UNFOLDED = { maxSources: Infinity, maxCategoriesPerGroup: Infinity, minLeafShare: 0 };

interface MoneyFlowSectionProps {
  periodLabel: string;
  currentReport: MonthlyReport | undefined;
  budget: BudgetSnapshot | undefined;
  spendingCategories: TaxonomyCategory[];
  incomeCategories: TaxonomyCategory[];
  savingsCategories: TaxonomyCategory[];
  currency: string;
  isLoading: boolean;
  isMobile: boolean;
  onCategoryClick?: (categoryId: string) => void;
}

/**
 * "Where I am" money flow: the period's income, spending and saving as one
 * Sankey. Destinations zoom in to show all of their categories (the only way
 * to see categories on mobile, where the chart stops at groups), and
 * categories with subcategories zoom in to show those.
 */
export function MoneyFlowSection({
  periodLabel,
  currentReport,
  budget,
  spendingCategories,
  incomeCategories,
  savingsCategories,
  currency,
  isLoading,
  isMobile,
  onCategoryClick,
}: MoneyFlowSectionProps) {
  const { t } = useTranslation();
  // Nodes zoomed into, outermost first: a group, then one of its categories.
  // The stage remounts this section per date range, so a zoom never outlives its period.
  const [path, setPath] = useState<string[]>([]);
  // Leaving a zoom unmounts its view: keyboard users land on the node that opened it.
  const [returnFocusId, setReturnFocusId] = useState<string | null>(null);
  const focusId = path.length > 0 ? path[path.length - 1] : null;
  /** Back to the view `depth` zooms in (0 is the overview). */
  const leaveZoom = (depth: number, viaKeyboard: boolean) => {
    if (viaKeyboard) setReturnFocusId(path[depth]);
    setPath(path.slice(0, depth));
  };

  const input = useMemo(() => {
    if (!currentReport) return null;
    return moneyFlowInputFromReport(
      currentReport,
      budget,
      { spending: spendingCategories, income: incomeCategories, savings: savingsCategories },
      {
        total: t("spending:moneyFlow.node.total"),
        shortfall: t("spending:moneyFlow.node.shortfall"),
        refunds: t("spending:moneyFlow.node.refunds"),
        saved: t("spending:whereIAm.setAside"),
        surplus: t("spending:moneyFlow.node.surplus"),
        uncategorized: t("spending:insightsPage.uncategorized"),
        uncategorizedIncome: t("spending:moneyFlow.node.uncategorizedIncome"),
        more: (count) => t("spending:whereIAm.moreCount", { count }),
        direct: t("spending:categorySheet.direct"),
        netSpending: t("spending:moneyFlow.node.netSpending"),
      },
    );
  }, [currentReport, budget, spendingCategories, incomeCategories, savingsCategories, t]);

  const graph = useMemo(
    () => (input ? buildMoneyFlowGraph(input, { includeCategories: !isMobile }) : null),
    [input, isMobile],
  );
  const isZoomed = path.length > 0;
  const unfolded = useMemo(
    () => (input && isZoomed ? buildMoneyFlowGraph(input, UNFOLDED) : null),
    [input, isZoomed],
  );
  const focusedGraph = useMemo(() => {
    if (!input || !unfolded || !focusId) return null;
    const focused = focusMoneyFlowGraph(unfolded, focusId, input.labels);
    return focused.nodes.length > 0 ? focused : null;
  }, [input, unfolded, focusId]);

  const isEmpty = !graph || graph.nodes.length === 0;
  if (!isLoading && isEmpty) return null;

  const focusedNode = focusedGraph?.nodes.find((node) => node.id === focusedGraph.rootId);
  // Two zooms deep, the way back names the view it returns to.
  const previousName =
    path.length > 1
      ? unfolded?.nodes.find((node) => node.id === path[path.length - 2])?.name
      : undefined;
  const transactionsCategoryId =
    focusedNode?.kind === "category" ? focusedNode.categoryId : undefined;
  const shownGraph = focusedGraph ?? graph;
  const subtitle = !focusedNode
    ? t("spending:moneyFlow.subtitle", { period: periodLabel })
    : focusedNode.kind === "category" || focusedNode.kind === "income"
      ? t("spending:moneyFlow.focusSubcategoriesSubtitle", { period: periodLabel })
      : t("spending:moneyFlow.focusSubtitle", { period: periodLabel });

  return (
    // `#cashflow` is the dashboard's deep link into this section.
    <section
      id="cashflow"
      onKeyDown={(event) => {
        if (event.key === "Escape" && focusedNode) leaveZoom(path.length - 1, true);
      }}
    >
      <header className="mb-3 min-w-0">
        <h2 className="text-foreground truncate text-base font-semibold tracking-tight">
          {focusedNode ? focusedNode.name : t("spending:moneyFlow.title")}
        </h2>
        <p className="text-muted-foreground text-xs">{subtitle}</p>
      </header>

      <div className="border-border/60 bg-card/40 rounded-2xl border px-2 py-3 backdrop-blur-xl md:px-4 md:py-4">
        {focusedNode && (
          // The zoomed node unmounts, so focus lands on the way back: keyed per
          // view so it lands there again one zoom deeper.
          <div
            key={`toolbar:${focusId}`}
            className="mb-2 flex min-w-0 items-center justify-between gap-2"
          >
            <div className="flex min-w-0 items-center gap-1">
              <Button
                variant="outline"
                size="sm"
                autoFocus
                aria-label={
                  previousName ? t("spending:moneyFlow.backTo", { name: previousName }) : undefined
                }
                // `detail` is 0 when Enter or Space pressed the button.
                onClick={(event) => leaveZoom(path.length - 1, event.detail === 0)}
                // `Button` is `shrink-0` by default: let a long group name truncate.
                className="h-7 min-w-0 shrink gap-1 px-2.5 text-xs"
              >
                <Icons.ArrowLeft className="size-3.5 shrink-0" aria-hidden />
                <span className="truncate">{previousName ?? t("spending:moneyFlow.back")}</span>
              </Button>
              {previousName && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={(event) => leaveZoom(0, event.detail === 0)}
                  className="text-muted-foreground h-7 shrink-0 px-2 text-xs"
                >
                  {t("spending:moneyFlow.back")}
                </Button>
              )}
            </div>
            {transactionsCategoryId && onCategoryClick && (
              <Button
                variant="outline"
                size="sm"
                className="h-7 shrink-0 gap-1.5 px-2.5 text-xs"
                onClick={() => onCategoryClick(transactionsCategoryId)}
              >
                <Icons.ReceiptText className="size-3.5" aria-hidden />
                {t("spending:moneyFlow.action.transactions")}
              </Button>
            )}
          </div>
        )}
        {isLoading || !shownGraph ? (
          <MoneyFlowSkeleton />
        ) : (
          <MoneyFlowChart
            // Remount on zoom: replays the reveal and drops hover state.
            key={focusedGraph ? focusId : "all"}
            graph={shownGraph}
            currency={currency}
            isMobile={isMobile}
            onCategoryClick={onCategoryClick}
            // From the overview a zoom starts afresh, even if a stale one never showed.
            onFocusNode={(id) => setPath(focusedGraph ? [...path, id] : [id])}
            autoFocusNodeId={returnFocusId}
            onAutoFocused={() => setReturnFocusId(null)}
          />
        )}
        {!isLoading && !focusedGraph && !isEmpty && graph.totals.income === 0 && (
          <p className="text-muted-foreground/80 text-2xs px-2 pt-2">
            {t("spending:whereIAm.noIncome")}
          </p>
        )}
      </div>
    </section>
  );
}

function MoneyFlowSkeleton() {
  return (
    <div className="flex h-[300px] items-stretch gap-6 px-2 py-2">
      <div className="flex w-1/5 flex-col justify-center gap-3">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
      <Skeleton className="w-1/5" />
      <div className="flex w-1/5 flex-col justify-between gap-3">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-8 w-full" />
      </div>
      <div className="flex flex-1 flex-col justify-between gap-2">
        {Array.from({ length: 7 }).map((_, i) => (
          <Skeleton key={i} className="h-6 w-full" />
        ))}
      </div>
    </div>
  );
}
