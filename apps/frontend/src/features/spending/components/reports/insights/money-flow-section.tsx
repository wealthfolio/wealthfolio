import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import type { TaxonomyCategory } from "@/lib/types";
import { Icons, Skeleton } from "@wealthfolio/ui";

import {
  buildMoneyFlowGraph,
  focusMoneyFlowGraph,
  moneyFlowInputFromReport,
} from "../../../lib/money-flow";
import type { BudgetSnapshot } from "../../../types/budget";
import type { MonthlyReport } from "../../../types/report";
import { MoneyFlowChart } from "./money-flow-chart";

/** Zoomed views show every category; nothing folds into "+N more". */
const UNFOLDED = { maxCategoriesPerGroup: Infinity, minLeafShare: 0 };

interface MoneyFlowSectionProps {
  periodLabel: string;
  currentReport: MonthlyReport | undefined;
  budget: BudgetSnapshot | undefined;
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
 * to see categories on mobile, where the chart stops at groups).
 */
export function MoneyFlowSection({
  periodLabel,
  currentReport,
  budget,
  incomeCategories,
  savingsCategories,
  currency,
  isLoading,
  isMobile,
  onCategoryClick,
}: MoneyFlowSectionProps) {
  const { t } = useTranslation();
  // The stage remounts this section per date range, so a zoom never outlives its period.
  const [focusId, setFocusId] = useState<string | null>(null);
  // Leaving a zoom unmounts the back button: keyboard users land on the node they zoomed into.
  const [returnFocusId, setReturnFocusId] = useState<string | null>(null);
  const leaveZoom = (viaKeyboard: boolean) => {
    if (viaKeyboard) setReturnFocusId(focusId);
    setFocusId(null);
  };

  const input = useMemo(() => {
    if (!currentReport) return null;
    return moneyFlowInputFromReport(
      currentReport,
      budget,
      { income: incomeCategories, savings: savingsCategories },
      {
        total: t("spending:moneyFlow.node.total"),
        shortfall: t("spending:moneyFlow.node.shortfall"),
        refunds: t("spending:moneyFlow.node.refunds"),
        saved: t("spending:whereIAm.setAside"),
        surplus: t("spending:moneyFlow.node.surplus"),
        uncategorized: t("spending:insightsPage.uncategorized"),
        uncategorizedIncome: t("spending:moneyFlow.node.uncategorizedIncome"),
        more: (count) => t("spending:whereIAm.moreCount", { count }),
      },
    );
  }, [currentReport, budget, incomeCategories, savingsCategories, t]);

  const graph = useMemo(
    () => (input ? buildMoneyFlowGraph(input, { includeCategories: !isMobile }) : null),
    [input, isMobile],
  );
  const focusedGraph = useMemo(() => {
    if (!input || !focusId) return null;
    const focused = focusMoneyFlowGraph(buildMoneyFlowGraph(input, UNFOLDED), focusId);
    return focused.nodes.length > 0 ? focused : null;
  }, [input, focusId]);

  const isEmpty = !graph || graph.nodes.length === 0;
  if (!isLoading && isEmpty) return null;

  const focusedNode = focusedGraph?.nodes[0];
  const shownGraph = focusedGraph ?? graph;
  const subtitle = focusedNode
    ? t("spending:moneyFlow.focusSubtitle", { period: periodLabel })
    : t("spending:moneyFlow.subtitle", { period: periodLabel });

  return (
    // `#cashflow` is the dashboard's deep link into this section.
    <section
      id="cashflow"
      onKeyDown={(event) => {
        if (event.key === "Escape" && focusedNode) leaveZoom(true);
      }}
    >
      <header className="mb-3 min-w-0">
        {focusedNode ? (
          <>
            {/* The zoomed node unmounts, so focus lands on the way back. */}
            <button
              type="button"
              autoFocus
              // `detail` is 0 when Enter or Space pressed the button.
              onClick={(event) => leaveZoom(event.detail === 0)}
              className="text-muted-foreground hover:text-foreground -ml-1 mb-0.5 inline-flex items-center gap-1 rounded-md px-1 text-xs transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--ring)]"
            >
              <Icons.ArrowLeft className="size-3" />
              {t("spending:moneyFlow.back")}
            </button>
            <h2 className="text-foreground truncate text-base font-semibold tracking-tight">
              {focusedNode.name}
            </h2>
          </>
        ) : (
          <h2 className="text-foreground text-base font-semibold tracking-tight">
            {t("spending:moneyFlow.title")}
          </h2>
        )}
        <p className="text-muted-foreground text-xs">{subtitle}</p>
      </header>

      <div className="border-border/60 bg-card/40 rounded-2xl border px-2 py-3 backdrop-blur-xl md:px-4 md:py-4">
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
            onFocusNode={focusedGraph ? undefined : setFocusId}
            autoFocusNodeId={focusedGraph ? null : returnFocusId}
            onAutoFocused={() => setReturnFocusId(null)}
          />
        )}
        {!isLoading && !focusedGraph && !isEmpty && graph.totals.income === 0 && (
          <p className="text-muted-foreground/80 px-2 pt-2 text-[11px]">
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
