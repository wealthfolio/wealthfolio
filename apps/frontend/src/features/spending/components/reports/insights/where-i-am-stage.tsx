import { useMemo, useState, type FC, type ReactNode } from "react";
import { Link } from "react-router-dom";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Icons,
  PrivacyAmount,
  Skeleton,
  formatCompactAmount,
} from "@wealthfolio/ui";
import { useBalancePrivacy } from "@/hooks/use-balance-privacy";
import type { TaxonomyCategory } from "@/lib/types";
import { cn, formatAmount } from "@/lib/utils";

import { rollUpToTopLevel, topCategoryId } from "../../../lib/category-rollup";
import type { ReportsRange } from "../../../lib/reports-period";
import type { BudgetCategoryRow, BudgetSnapshot } from "../../../types/budget";
import type { PaceState } from "../../../types/insight";
import type { CategoryBreakdownRow, MonthBucket, MonthlyReport } from "../../../types/report";
import { CategoryHierarchyTable, type CategorySort } from "../category-hierarchy-table";
import { formatMonthName, formatPercentValue } from "./format";

// ─── shared chrome ────────────────────────────────────────────────────────

const CARD_CLASS = "border-border/60 bg-card/40 rounded-2xl border p-5 backdrop-blur-xl";
const LABEL_CLASS =
  "text-muted-foreground/70 text-[10px] font-semibold uppercase tracking-[0.12em]";

// ═════════════════════════════════════════════════════════════════════════
// Top of page — pace narrative + spent + cashflow
// ═════════════════════════════════════════════════════════════════════════

export interface WhereIAmStageProps {
  range: ReportsRange;
  currentReport: MonthlyReport | undefined;
  priorReport: MonthlyReport | undefined;
  months: MonthBucket[];
  taxonomyCategories: TaxonomyCategory[];
  budget: BudgetSnapshot | undefined;
  currency: string;
  isLoading: boolean;
  /**
   * Reconciled pace shipped by the backend. When provided, the pace card uses
   * it verbatim instead of re-deriving daysElapsed/dailyAvg/projection locally
   * — this is the same payload that drives headline.spent so the surfaces
   * agree by construction. Falls back to the local derivation when absent.
   */
  reconciledPace?: PaceState;
  /** Reserved for callers that want to scroll to the breakdown — currently unused. */
  onJumpToBreakdown?: () => void;
  onCategoryClick?: (categoryId: string) => void;
}

export function WhereIAmStage({
  range,
  currentReport,
  priorReport,
  months,
  taxonomyCategories,
  budget,
  currency,
  isLoading,
  reconciledPace,
  onCategoryClick,
}: WhereIAmStageProps) {
  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-4 md:grid-cols-3">
        <PaceCard
          range={range}
          spent={currentReport?.current.outflow ?? 0}
          budget={budget}
          currency={currency}
          isLoading={isLoading}
          reconciledPace={reconciledPace}
        />
        <SpentThisPeriodCard
          range={range}
          spent={currentReport?.current.outflow ?? 0}
          priorSpent={priorReport?.current.outflow}
          breakdown={currentReport?.spendingBreakdown ?? []}
          taxonomyCategories={taxonomyCategories}
          currency={currency}
          isLoading={isLoading}
        />
        <NetCashflowCard months={months} currency={currency} isLoading={isLoading} />
      </div>
      <BreakdownCanvas
        currentReport={currentReport}
        priorReport={priorReport}
        budget={budget}
        taxonomyCategories={taxonomyCategories}
        currency={currency}
        range={range}
        isLoading={isLoading}
        onCategoryClick={onCategoryClick}
      />
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════
// Pace card — narrative-style hero
// ═════════════════════════════════════════════════════════════════════════

interface PaceCardProps {
  range: ReportsRange;
  spent: number;
  budget: BudgetSnapshot | undefined;
  currency: string;
  isLoading: boolean;
  /**
   * Reconciled pace from the backend insight payload. When provided, drives
   * daysElapsed/dailyAvg/projectedSpend directly so this card agrees with
   * headline.spent. Falls back to the local derivation when absent.
   */
  reconciledPace?: PaceState;
}

const PaceCard: FC<PaceCardProps> = ({
  range,
  spent,
  budget,
  currency,
  isLoading,
  reconciledPace,
}) => {
  const { isBalanceHidden } = useBalancePrivacy();
  // `spendingPlanned` is the period-level target straight from the insight
  // payload (already buffered + prorated). No range.months multiplier.
  const target = budget?.computed.totals.spendingPlanned ?? 0;

  const pace = useMemo(
    () => computePace(range, spent, target, currency, isBalanceHidden, reconciledPace),
    [range, spent, target, currency, isBalanceHidden, reconciledPace],
  );

  if (isLoading) {
    return (
      <div className={CARD_CLASS}>
        <Skeleton className="h-2 w-full" />
        <Skeleton className="mt-4 h-3 w-32" />
        <Skeleton className="mt-3 h-20 w-full" />
        <Skeleton className="mt-6 h-2 w-full" />
        <Skeleton className="mt-2 h-3 w-2/3" />
      </div>
    );
  }

  const status = pace.status;
  const statusColor =
    status === "over"
      ? "var(--destructive)"
      : status === "approach"
        ? "var(--status-warn)"
        : "var(--success)";
  const statusLabel =
    status === "over" ? "OVER BUDGET" : status === "approach" ? "TRENDING HIGH" : "ON TRACK";

  if (target <= 0) {
    return (
      <div className={CARD_CLASS}>
        <div className={LABEL_CLASS}>NO BUDGET SET</div>
        <p className="text-foreground mt-3 text-lg font-semibold leading-snug tracking-tight">
          Set a monthly target to see how you're pacing.
        </p>
        <p className="text-muted-foreground/80 mt-2 text-sm">
          A budget unlocks pace, projection, and remaining-balance signals on this card.
        </p>
        <Link
          to="/spending/budget"
          className="text-foreground mt-6 inline-flex items-center gap-1 text-xs font-medium underline-offset-4 hover:underline"
        >
          Create a budget →
        </Link>
      </div>
    );
  }

  return (
    <div className={CARD_CLASS}>
      {/* Row 1 — label + context (matches the other two cards' top row) */}
      <div className="flex items-baseline justify-between gap-2">
        <div className="inline-flex items-center gap-1.5">
          <span
            className="block h-1.5 w-1.5 rounded-full"
            style={{ backgroundColor: statusColor }}
          />
          <span className={LABEL_CLASS} style={{ color: statusColor }}>
            {statusLabel}
          </span>
        </div>
        <span className="text-muted-foreground/70 text-[11px]">{pace.contextRight}</span>
      </div>

      {/* Row 2 — text insight (replaces the redundant "big number" — that fact
          already lives in the Spent card next to it). Serif for editorial feel. */}
      <div className="mt-3">{pace.narrative}</div>

      {/* Row 3 — progress bar with pace tick */}
      <div className="bg-foreground/10 relative mt-4 h-2 w-full overflow-hidden rounded-full">
        <div
          className="h-full rounded-full transition-all"
          style={{
            width: `${Math.min(100, pace.percentSpent * 100)}%`,
            backgroundColor: statusColor,
            opacity: 0.7,
          }}
        />
        <div
          className="bg-foreground/70 absolute inset-y-0 w-px"
          style={{ left: `${Math.min(100, pace.percentPace * 100)}%` }}
          aria-hidden
          title={`Pace ${formatPercentValue(pace.percentPace * 100, { digits: 0 })}`}
        />
      </div>
    </div>
  );
};

interface PaceComputed {
  status: "ok" | "approach" | "over";
  narrative: ReactNode;
  contextRight: string;
  percentSpent: number;
  percentPace: number;
  dailyAvg: number;
  expectedDailyPace: number;
  projection: number;
  /** Spent − expectedSoFar. Positive = over pace, negative = under. */
  diffFromPace: number;
}

function computePace(
  range: ReportsRange,
  spent: number,
  target: number,
  currency: string,
  isBalanceHidden: boolean,
  reconciledPace?: PaceState,
): PaceComputed {
  // Determine elapsed fraction of the active range. For periods that include
  // "today" we treat (today - start)/(end - start) as elapsed; for fully-past
  // ranges elapsed = 1 (everything has happened).
  const now = Date.now();
  const startMs = range.start.getTime();
  const endMs = range.end.getTime();
  const isLive = now >= startMs && now <= endMs;
  const elapsed = isLive ? Math.max(0.001, (now - startMs) / (endMs - startMs)) : 1;

  const totalDays = range.days;
  // Prefer reconciled values from the backend insight payload so this card
  // agrees with headline.spent / status / pace by construction. Fall back to
  // a local derivation only when the caller didn't pass a reconciled pace
  // (e.g. older callers still being wired up).
  const daysElapsed = reconciledPace
    ? Math.max(0, reconciledPace.daysElapsed)
    : isLive
      ? Math.max(1, Math.round(totalDays * elapsed))
      : totalDays;
  const daysRemaining = reconciledPace
    ? Math.max(0, reconciledPace.daysRemaining)
    : Math.max(0, totalDays - daysElapsed);

  // Day-1 / very-early-period guard: a single charge on day 1 would project
  // to spent × totalDays, producing absurd "projected $20k" headlines.
  // Suppress projection until we have at least 7 days of data, matching the
  // forecast-reliability rule already used by budget-line-chart-card.tsx.
  const PROJECTION_MIN_DAYS = 7;
  const projectionReliable = !isLive || daysElapsed >= PROJECTION_MIN_DAYS;

  const dailyAvg = reconciledPace?.dailyAvg ?? (daysElapsed > 0 ? spent / daysElapsed : 0);
  const expectedDailyPace = target > 0 && totalDays > 0 ? target / totalDays : 0;

  const percentSpent = target > 0 ? spent / target : 0;
  const percentPace = isLive ? elapsed : 1;

  const projection = !isLive
    ? spent
    : !projectionReliable
      ? spent
      : (reconciledPace?.projectedSpend ?? dailyAvg * totalDays);
  const expectedSoFar = reconciledPace?.expectedSpendToDate ?? expectedDailyPace * daysElapsed;
  const diffFromPace = spent - expectedSoFar;

  const status: PaceComputed["status"] =
    percentSpent > 1 ? "over" : percentSpent >= 0.85 ? "approach" : "ok";

  // Right-side context line. "left in [month]" only makes sense when the
  // window IS that month; for multi-month windows say "left in the period".
  const contextRight = !isLive
    ? `${totalDays} ${totalDays === 1 ? "day" : "days"} · period closed`
    : daysRemaining === 0
      ? "Last day of the period"
      : `${daysRemaining} ${daysRemaining === 1 ? "day" : "days"} left ${
          range.months <= 1 ? `in ${formatMonthName(range.end)}` : "in the period"
        }`;

  // Narrative sentence. When the window is closed OR today is the last day,
  // there's nothing to project — describe the actual outcome instead.
  const isComplete = !isLive || daysRemaining === 0;
  const closeLabel = range.months <= 1 ? "month end" : "period close";
  const narrative = isComplete
    ? buildClosedNarrative({ spent, target, currency, isBalanceHidden })
    : buildLiveNarrative({
        diffFromPace,
        projection,
        target,
        currency,
        closeLabel,
        isBalanceHidden,
      });

  return {
    status,
    narrative,
    contextRight,
    percentSpent,
    percentPace,
    dailyAvg,
    expectedDailyPace,
    projection,
    diffFromPace,
  };
}

function buildLiveNarrative({
  diffFromPace,
  projection,
  target,
  currency,
  closeLabel,
  isBalanceHidden,
}: {
  diffFromPace: number;
  projection: number;
  target: number;
  currency: string;
  closeLabel: string;
  isBalanceHidden: boolean;
}): ReactNode {
  const direction = diffFromPace > 0 ? "over" : "under";
  const colorClass = diffFromPace > 0 ? "text-destructive" : "text-success";
  const projColorClass = projection > target ? "text-destructive" : "text-success";
  const pctOfBudget = target > 0 ? (projection / target) * 100 : 0;

  return (
    <div className="flex flex-col gap-1.5">
      <div
        className={cn(
          "font-serif text-lg font-medium leading-tight tracking-tight md:text-xl",
          colorClass,
        )}
      >
        {isBalanceHidden ? "••••" : formatCompactAmount(Math.abs(diffFromPace), currency)}{" "}
        {direction} pace
      </div>
      <div className="text-foreground/90 text-sm">
        Projected{" "}
        <span className={cn("font-serif font-medium", projColorClass)}>
          {isBalanceHidden ? "••••" : formatCompactAmount(projection, currency)}
        </span>{" "}
        by {closeLabel}
      </div>
      <div className="text-muted-foreground/80 text-xs tabular-nums">
        {formatPercentValue(pctOfBudget, { digits: 0 })} of budget
      </div>
    </div>
  );
}

function buildClosedNarrative({
  spent,
  target,
  currency,
  isBalanceHidden,
}: {
  spent: number;
  target: number;
  currency: string;
  isBalanceHidden: boolean;
}): ReactNode {
  const diff = spent - target;
  const colorClass = diff > 0 ? "text-destructive" : "text-success";
  const pctOfBudget = target > 0 ? (spent / target) * 100 : 0;
  return (
    <div className="flex flex-col gap-1.5">
      <div
        className={cn(
          "font-serif text-lg font-medium leading-tight tracking-tight md:text-xl",
          colorClass,
        )}
      >
        {isBalanceHidden ? "••••" : formatCompactAmount(spent, currency)} spent
      </div>
      <div className="text-foreground/90 text-sm">
        Against a {isBalanceHidden ? "••••" : formatCompactAmount(target, currency)} target —{" "}
        <span className={cn("font-medium", colorClass)}>
          {diff > 0 ? "over" : "under"} by{" "}
          {isBalanceHidden ? "••••" : formatCompactAmount(Math.abs(diff), currency)}
        </span>
      </div>
      <div className="text-muted-foreground/80 text-xs tabular-nums">
        {formatPercentValue(pctOfBudget, { digits: 0 })} of budget
      </div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════
// Spent this period card — segmented stacked bar + legend
// ═════════════════════════════════════════════════════════════════════════

interface SpentThisPeriodCardProps {
  range: ReportsRange;
  spent: number;
  priorSpent?: number;
  breakdown: CategoryBreakdownRow[];
  taxonomyCategories: TaxonomyCategory[];
  currency: string;
  isLoading: boolean;
}

const SpentThisPeriodCard: FC<SpentThisPeriodCardProps> = ({
  range,
  spent,
  priorSpent,
  breakdown,
  taxonomyCategories,
  currency,
  isLoading,
}) => {
  const { isBalanceHidden } = useBalancePrivacy();
  const segments = useMemo(
    () => buildShareSegments(breakdown, taxonomyCategories, spent),
    [breakdown, taxonomyCategories, spent],
  );

  const periodLabel =
    range.months <= 1
      ? "SPENT THIS MONTH"
      : range.months <= 3
        ? `SPENT THIS PERIOD`
        : `SPENT · ${range.months} MO`;

  const deltaPct =
    priorSpent != null && priorSpent > 0 ? ((spent - priorSpent) / priorSpent) * 100 : null;

  const priorLabel = useMemo(() => {
    if (range.months <= 1) {
      const prev = new Date(range.start);
      prev.setMonth(prev.getMonth() - 1);
      return `vs ${formatMonthName(prev).slice(0, 3)}`;
    }
    return "vs prior";
  }, [range]);

  if (isLoading) {
    return (
      <div className={CARD_CLASS}>
        <Skeleton className="h-3 w-24" />
        <Skeleton className="mt-3 h-7 w-32" />
        <Skeleton className="mt-4 h-1.5 w-full rounded-full" />
        <Skeleton className="mt-3 h-3 w-3/4" />
      </div>
    );
  }

  return (
    <div className={CARD_CLASS}>
      <div className={LABEL_CLASS}>{periodLabel}</div>
      <div className="mt-2 flex items-baseline justify-between gap-2">
        <div className="text-foreground text-2xl font-semibold tabular-nums tracking-tight">
          <PrivacyAmount value={spent} currency={currency} />
        </div>
        {deltaPct != null && (
          <span
            className={cn(
              "rounded-full px-2 py-0.5 text-[11px] font-medium tabular-nums",
              Math.abs(deltaPct) < 1
                ? "bg-muted/50 text-muted-foreground"
                : deltaPct > 0
                  ? "bg-amber-100/60 text-amber-800 dark:bg-amber-500/20 dark:text-amber-300"
                  : "bg-success/15 text-success",
            )}
          >
            {formatPercentValue(deltaPct, { digits: 0, signDisplay: "always" })} {priorLabel}
          </span>
        )}
      </div>

      {/* Segmented stacked bar */}
      {segments.length > 0 ? (
        <>
          <div className="bg-foreground/5 mt-4 flex h-2 w-full overflow-hidden rounded-full">
            {segments.map((s, i) => (
              <div
                key={s.id}
                className="h-full"
                style={{
                  width: `${s.share}%`,
                  backgroundColor: s.color,
                  borderRight: i < segments.length - 1 ? "1px solid var(--card)" : undefined,
                }}
                title={`${s.name} · ${
                  isBalanceHidden ? "••••" : formatAmount(s.amount, currency)
                } (${s.share.toFixed(1)}%)`}
              />
            ))}
          </div>
          <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
            {segments.slice(0, 4).map((s) => (
              <span key={s.id} className="inline-flex items-center gap-1.5">
                <span
                  className="block h-1.5 w-1.5 rounded-full"
                  style={{ backgroundColor: s.color }}
                />
                <span className="text-foreground/80">{s.name}</span>
                <span className="text-muted-foreground/70 tabular-nums">
                  {Math.round(s.share)}%
                </span>
              </span>
            ))}
            {segments.length > 4 && (
              <span className="text-muted-foreground/70 inline-flex items-center text-[11px]">
                +{segments.length - 4} more
              </span>
            )}
          </div>
        </>
      ) : (
        <div className="text-muted-foreground/70 mt-4 text-xs">
          No categorized spending in this period.
        </div>
      )}
    </div>
  );
};

interface ShareSegment {
  id: string;
  name: string;
  color: string;
  amount: number;
  share: number;
}

function buildShareSegments(
  breakdown: CategoryBreakdownRow[],
  taxonomyCategories: TaxonomyCategory[],
  total: number,
): ShareSegment[] {
  if (total <= 0) return [];
  const meta = new Map(taxonomyCategories.map((c) => [c.id, c]));
  const byTop = new Map<string, { name: string; color: string | null; amount: number }>();
  for (const r of breakdown) {
    const topId = topCategoryId(r.categoryId, meta);
    const top = meta.get(topId);
    if (!top) continue;
    const e = byTop.get(topId) ?? { name: top.name, color: top.color ?? null, amount: 0 };
    e.amount += r.amount;
    byTop.set(topId, e);
  }
  const positiveEntries = Array.from(byTop.entries()).filter(([, e]) => e.amount > 0);
  const positiveTotal = positiveEntries.reduce((sum, [, e]) => sum + e.amount, 0);
  if (positiveTotal <= 0) return [];

  const sorted = positiveEntries
    .map(([id, e]) => ({
      id,
      name: e.name,
      color: e.color ?? "#9CA3AF",
      amount: e.amount,
      share: (e.amount / positiveTotal) * 100,
    }))
    .sort((a, b) => b.amount - a.amount);
  const top = sorted.slice(0, 6);
  const rest = sorted.slice(6).reduce((s, x) => s + x.amount, 0);
  if (rest > 0) {
    top.push({
      id: "__other__",
      name: "Other",
      color: "#9CA3AF",
      amount: rest,
      share: (rest / positiveTotal) * 100,
    });
  }
  return top;
}

// ═════════════════════════════════════════════════════════════════════════
// Net cashflow card
// ═════════════════════════════════════════════════════════════════════════

interface NetCashflowCardProps {
  months: MonthBucket[];
  currency: string;
  isLoading: boolean;
}

const NetCashflowCard: FC<NetCashflowCardProps> = ({ months, currency, isLoading }) => {
  const totals = useMemo(() => {
    let income = 0;
    let spent = 0;
    for (const m of months) {
      income += m.report?.current.income ?? 0;
      spent += m.report?.current.outflow ?? 0;
    }
    const net = income - spent;
    const savingsRate = income > 0 ? net / income : 0;
    return { income, spent, net, savingsRate };
  }, [months]);

  if (isLoading) {
    return (
      <div className={CARD_CLASS}>
        <Skeleton className="h-3 w-24" />
        <Skeleton className="mt-3 h-7 w-32" />
        <Skeleton className="mt-4 h-1.5 w-full rounded-full" />
        <Skeleton className="mt-2 h-1.5 w-full rounded-full" />
      </div>
    );
  }

  const denom = Math.max(totals.income, totals.spent, 1);
  const incomePct = (totals.income / denom) * 100;
  const spentPct = (totals.spent / denom) * 100;
  const netToneClass = totals.net >= 0 ? "text-success" : "text-destructive";

  return (
    <div className={CARD_CLASS}>
      <div className="flex items-baseline justify-between">
        <div className={LABEL_CLASS}>NET CASHFLOW</div>
      </div>
      <div className="mt-2 flex items-baseline justify-between gap-2">
        <div className={cn("text-2xl font-semibold tabular-nums tracking-tight", netToneClass)}>
          {totals.net >= 0 ? "+" : "−"}
          <PrivacyAmount value={Math.abs(totals.net)} currency={currency} />
        </div>
        {totals.income > 0 && (
          <span
            className={cn(
              "rounded-full px-2 py-0.5 text-[11px] font-medium tabular-nums",
              totals.net >= 0 ? "bg-success/15 text-success" : "bg-destructive/15 text-destructive",
            )}
          >
            {(() => {
              // Saved → savings rate (net/income), capped at 100% since you
              // can't save more than your income.
              // Overspent → deficit as % of income ("by N%"). For deficits
              // greater than 100% of income the literal number ("Overspent
              // 250%") is misleading — cap the display at "by 100%+".
              const ratePct = Math.abs(totals.savingsRate) * 100;
              if (totals.net >= 0) {
                return `Saved ${formatPercentValue(Math.min(100, ratePct), { digits: 0 })}`;
              }
              return ratePct >= 100
                ? "Overspent by 100%+"
                : `Overspent by ${formatPercentValue(ratePct, { digits: 0 })}`;
            })()}
          </span>
        )}
      </div>

      <div className="mt-4 space-y-2">
        <div className="flex items-center gap-2 text-[11px]">
          <span className="text-muted-foreground w-12 shrink-0">Income</span>
          <div className="bg-foreground/5 h-1.5 flex-1 overflow-hidden rounded-full">
            <div
              className="bg-success/65 h-full rounded-full transition-all"
              style={{ width: `${incomePct}%` }}
            />
          </div>
          <span className="text-foreground/90 w-20 shrink-0 text-right font-semibold tabular-nums">
            <PrivacyAmount value={totals.income} currency={currency} />
          </span>
        </div>
        {totals.income === 0 && (
          <p className="text-muted-foreground/70 pl-14 text-[10px] leading-snug">
            No income in selected accounts for this period.
          </p>
        )}
        <div className="flex items-center gap-2 text-[11px]">
          <span className="text-muted-foreground w-12 shrink-0">Spent</span>
          <div className="bg-foreground/5 h-1.5 flex-1 overflow-hidden rounded-full">
            <div
              className="bg-foreground/60 h-full rounded-full transition-all"
              style={{ width: `${spentPct}%` }}
            />
          </div>
          <span className="text-foreground/90 w-20 shrink-0 text-right font-semibold tabular-nums">
            <PrivacyAmount value={totals.spent} currency={currency} />
          </span>
        </div>
      </div>
    </div>
  );
};

// ═════════════════════════════════════════════════════════════════════════
// Breakdown canvas — chips + sort + footer wrapping the table
// ═════════════════════════════════════════════════════════════════════════

type BreakdownFilter = "all" | "over" | "movers" | "no_budget";
type BreakdownSort = CategorySort;

const SORT_OPTIONS: BreakdownSort[] = ["spent", "delta", "name"];
const SORT_LABELS: Record<BreakdownSort, string> = {
  spent: "spent",
  delta: "change",
  name: "name",
};

interface BreakdownCanvasProps {
  currentReport: MonthlyReport | undefined;
  priorReport: MonthlyReport | undefined;
  budget: BudgetSnapshot | undefined;
  taxonomyCategories: TaxonomyCategory[];
  currency: string;
  range: ReportsRange;
  isLoading: boolean;
  onCategoryClick?: (categoryId: string) => void;
}

function BreakdownCanvas({
  currentReport,
  priorReport,
  budget,
  taxonomyCategories,
  currency,
  range,
  isLoading,
  onCategoryClick,
}: BreakdownCanvasProps) {
  const [filter, setFilter] = useState<BreakdownFilter>("all");
  const [sort, setSort] = useState<BreakdownSort>("spent");

  // Memoize these so downstream `counts`/`filteredBreakdown` memos stay valid
  // — otherwise a fresh array on every render busts memoization.
  const budgetRows = useMemo(
    () => budget?.computed.groupRows.flatMap((row) => row.categories) ?? [],
    [budget],
  );
  const groupRows = useMemo(() => budget?.computed.groupRows ?? [], [budget]);
  const breakdown = useMemo(() => currentReport?.spendingBreakdown ?? [], [currentReport]);
  const priorBreakdown = useMemo(() => priorReport?.spendingBreakdown ?? [], [priorReport]);

  const counts = useMemo(
    () =>
      computeFilterCounts({
        breakdown,
        priorBreakdown,
        budgetRows,
        taxonomyCategories,
      }),
    [breakdown, priorBreakdown, budgetRows, taxonomyCategories],
  );

  const filteredBreakdown = useMemo(
    () =>
      filterBreakdown({
        filter,
        breakdown,
        priorBreakdown,
        budgetRows,
        taxonomyCategories,
      }),
    [filter, breakdown, priorBreakdown, budgetRows, taxonomyCategories],
  );

  const totalCats = counts.all;
  const shownCats = useMemo(
    () => countTopLevel(filteredBreakdown, taxonomyCategories),
    [filteredBreakdown, taxonomyCategories],
  );

  const periodLabel = useMemo(() => buildPeriodSubtitle(range), [range]);

  const filterChips = useMemo<{ id: BreakdownFilter; label: string; count: number }[]>(
    () => [
      { id: "all", label: "All", count: counts.all },
      { id: "over", label: "Over budget", count: counts.over },
      { id: "movers", label: "Largest movers", count: counts.movers },
      { id: "no_budget", label: "No budget set", count: counts.noBudget },
    ],
    [counts],
  );

  return (
    <section id="breakdown">
      <header className="mb-3 flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 className="text-foreground text-base font-semibold tracking-tight">Breakdown</h2>
          <p className="text-muted-foreground text-xs">
            Where {periodLabel} went — tap any category to see subcategories.
          </p>
        </div>
        <div className="text-muted-foreground/80 inline-flex items-center gap-1.5 text-xs">
          <span>Sort by</span>
          <DropdownMenu>
            <DropdownMenuTrigger
              aria-label={`Sort by ${SORT_LABELS[sort]}`}
              className="bg-secondary text-foreground hover:bg-secondary/80 inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium tabular-nums focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--ring)]"
            >
              {SORT_LABELS[sort]}
              <Icons.ChevronDown className="size-3 opacity-60" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-[140px]">
              {SORT_OPTIONS.map((opt) => (
                <DropdownMenuItem
                  key={opt}
                  onSelect={() => setSort(opt)}
                  className={cn("text-xs", sort === opt && "font-semibold")}
                >
                  {SORT_LABELS[opt]}
                  {sort === opt && <Icons.Check className="ml-auto size-3" />}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      <div className="-mx-2 mb-3 flex gap-2 overflow-x-auto px-2 pb-1 md:mx-0 md:flex-wrap md:overflow-visible md:px-0 md:pb-0 [&::-webkit-scrollbar]:hidden">
        {filterChips.map((chip) => {
          const active = filter === chip.id;
          return (
            <button
              key={chip.id}
              type="button"
              onClick={() => setFilter(chip.id)}
              className={cn(
                "inline-flex shrink-0 items-center gap-2 whitespace-nowrap rounded-full px-3 py-1 text-xs transition-colors",
                active
                  ? "bg-foreground text-background"
                  : "border-border/60 text-muted-foreground hover:text-foreground border bg-transparent",
              )}
            >
              <span>{chip.label}</span>
              <span
                className={cn(
                  "rounded-full px-1.5 text-[10px] font-medium tabular-nums",
                  active ? "bg-background/20" : "bg-muted/60",
                )}
              >
                {chip.count}
              </span>
            </button>
          );
        })}
      </div>

      <div className="md:border-border/60 md:bg-card/40 md:overflow-hidden md:rounded-2xl md:border md:backdrop-blur-xl">
        <CategoryHierarchyTable
          breakdown={filteredBreakdown}
          priorBreakdown={priorBreakdown}
          budgetRows={budgetRows}
          groupRows={groupRows}
          taxonomyCategories={taxonomyCategories}
          sort={sort}
          currency={currency}
          isLoading={isLoading}
          onCategoryClick={onCategoryClick}
        />
        {/* Desktop footer: count + link */}
        <div className="text-muted-foreground/80 border-border/40 hidden items-center justify-between border-t px-4 py-3 text-xs md:flex">
          <span className="tabular-nums">
            {shownCats} of {totalCats} categor{totalCats === 1 ? "y" : "ies"} shown
          </span>
          <Link
            to="/activities?tab=spending"
            className="text-foreground hover:text-foreground/80 inline-flex items-center gap-1 font-medium underline-offset-4 hover:underline"
          >
            Open transactions →
          </Link>
        </div>
        {/* Mobile footer: full-width primary action */}
        <div className="mt-4 md:hidden">
          <Link
            to="/activities?tab=spending"
            className="bg-foreground text-background hover:bg-foreground/90 flex h-11 w-full items-center justify-center gap-2 rounded-full text-sm font-medium transition-colors"
          >
            Open transactions
            <Icons.ArrowRight className="h-4 w-4" aria-hidden />
          </Link>
        </div>
      </div>
    </section>
  );
}

interface FilterCounts {
  all: number;
  over: number;
  movers: number;
  noBudget: number;
}

function computeFilterCounts({
  breakdown,
  priorBreakdown,
  budgetRows,
  taxonomyCategories,
}: {
  breakdown: CategoryBreakdownRow[];
  priorBreakdown: CategoryBreakdownRow[];
  budgetRows: BudgetCategoryRow[];
  taxonomyCategories: TaxonomyCategory[];
}): FilterCounts {
  const meta = new Map(taxonomyCategories.map((c) => [c.id, c]));
  const allocMap = new Map(budgetRows.map((a) => [a.categoryId, a.target || 0]));
  const totals = rollUpToTopLevel(breakdown, meta);
  const priorTotals = rollUpToTopLevel(priorBreakdown, meta);
  const all = totals.size;
  let over = 0;
  let movers = 0;
  let noBudget = 0;
  for (const [id, amt] of totals) {
    const budgetForTop = sumAllocationsForTop(id, meta, allocMap);
    if (budgetForTop > 0 && amt > budgetForTop) over += 1;
    const prior = priorTotals.get(id) ?? 0;
    if (prior > 0) {
      const pct = Math.abs((amt - prior) / prior) * 100;
      if (pct >= 20) movers += 1;
    }
    if (budgetForTop <= 0) noBudget += 1;
  }
  return { all, over, movers, noBudget };
}

function sumAllocationsForTop(
  topId: string,
  meta: Map<string, TaxonomyCategory>,
  allocMap: Map<string, number>,
): number {
  let total = allocMap.get(topId) ?? 0;
  for (const c of meta.values()) {
    if (c.parentId === topId) total += allocMap.get(c.id) ?? 0;
  }
  return total;
}

function filterBreakdown({
  filter,
  breakdown,
  priorBreakdown,
  budgetRows,
  taxonomyCategories,
}: {
  filter: BreakdownFilter;
  breakdown: CategoryBreakdownRow[];
  priorBreakdown: CategoryBreakdownRow[];
  budgetRows: BudgetCategoryRow[];
  taxonomyCategories: TaxonomyCategory[];
}): CategoryBreakdownRow[] {
  if (filter === "all") return breakdown;
  const meta = new Map(taxonomyCategories.map((c) => [c.id, c]));
  const allocMap = new Map(budgetRows.map((a) => [a.categoryId, a.target || 0]));
  const totals = rollUpToTopLevel(breakdown, meta);
  const priorTotals = rollUpToTopLevel(priorBreakdown, meta);
  const allowed = new Set<string>();
  for (const [topId, amt] of totals) {
    const budgetForTop = sumAllocationsForTop(topId, meta, allocMap);
    if (filter === "over" && budgetForTop > 0 && amt > budgetForTop) allowed.add(topId);
    if (filter === "no_budget" && budgetForTop <= 0) allowed.add(topId);
    if (filter === "movers") {
      const prior = priorTotals.get(topId) ?? 0;
      if (prior > 0 && Math.abs((amt - prior) / prior) * 100 >= 20) allowed.add(topId);
    }
  }
  return breakdown.filter((r) => allowed.has(topCategoryId(r.categoryId, meta)));
}

/** Subtitle copy that reflects the active range, not just the start month. */
function buildPeriodSubtitle(range: ReportsRange): string {
  if (range.months <= 1) return formatMonthName(range.start);
  const start = formatMonthName(range.start);
  const end = formatMonthName(range.end);
  const sameYear = range.start.getFullYear() === range.end.getFullYear();
  return sameYear
    ? `${start} → ${end}`
    : `${start} ${range.start.getFullYear()} → ${end} ${range.end.getFullYear()}`;
}

function countTopLevel(
  rows: CategoryBreakdownRow[],
  taxonomyCategories: TaxonomyCategory[],
): number {
  const meta = new Map(taxonomyCategories.map((c) => [c.id, c]));
  const tops = new Set<string>();
  for (const r of rows) tops.add(topCategoryId(r.categoryId, meta));
  return tops.size;
}
