import { useMemo, useState, type FC, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";

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

import { CategoryIcon } from "../../category-chips";
import { rollUpToTopLevel, topCategoryId } from "../../../lib/category-rollup";
import type { ReportsRange } from "../../../lib/reports-period";
import type { BudgetCategoryRow, BudgetSnapshot } from "../../../types/budget";
import type { PaceState } from "../../../types/insight";
import type { CategoryBreakdownRow, MonthBucket, MonthlyReport } from "../../../types/report";
import { CategoryHierarchyTable, type CategorySort } from "../category-hierarchy-table";
import { formatMonthDay, formatMonthName, formatPercentValue } from "./format";

// ─── shared chrome ────────────────────────────────────────────────────────

const CARD_CLASS =
  "border-border/60 bg-card/40 bg-gradient-to-br from-white/[0.07] via-transparent to-black/[0.04] dark:from-white/[0.025] dark:to-black/[0.06] rounded-2xl border p-5 backdrop-blur-xl";
const LABEL_CLASS =
  "text-muted-foreground/70 text-[10px] font-semibold uppercase tracking-[0.12em]";
const SAVINGS_GROUP_KEY = "savings";

// ═════════════════════════════════════════════════════════════════════════
// Top of page — pace narrative + spent + cashflow
// ═════════════════════════════════════════════════════════════════════════

export interface WhereIAmStageProps {
  range: ReportsRange;
  currentReport: MonthlyReport | undefined;
  priorReport: MonthlyReport | undefined;
  months: MonthBucket[];
  taxonomyCategories: TaxonomyCategory[];
  incomeCategories: TaxonomyCategory[];
  savingsCategories: TaxonomyCategory[];
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
  incomeCategories,
  savingsCategories,
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
      <CashflowOverview
        range={range}
        currentReport={currentReport}
        incomeCategories={incomeCategories}
        savingsCategories={savingsCategories}
        currency={currency}
        isLoading={isLoading}
      />
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
  const { t } = useTranslation();
  const { isBalanceHidden } = useBalancePrivacy();
  // `spendingPlanned` is the period-level target straight from the insight
  // payload (already buffered + prorated). No range.months multiplier.
  const target = budget?.computed.totals.spendingPlanned ?? 0;

  const pace = useMemo(
    () => computePace(range, spent, target, currency, isBalanceHidden, t, reconciledPace),
    [range, spent, target, currency, isBalanceHidden, t, reconciledPace],
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
    status === "over"
      ? t("spending:whereIAm.statusOverBudget")
      : status === "approach"
        ? t("spending:whereIAm.statusTrendingHigh")
        : t("spending:whereIAm.statusOnTrack");

  if (target <= 0) {
    return (
      <div className={CARD_CLASS}>
        <div className={LABEL_CLASS}>{t("spending:whereIAm.noBudgetSet")}</div>
        <p className="text-foreground mt-3 text-lg font-semibold leading-snug tracking-tight">
          {t("spending:whereIAm.noBudgetTitle")}
        </p>
        <p className="text-muted-foreground/80 mt-2 text-sm">
          {t("spending:whereIAm.noBudgetBody")}
        </p>
        <Link
          to="/spending/budget"
          className="text-foreground mt-6 inline-flex items-center gap-1 text-xs font-medium underline-offset-4 hover:underline"
        >
          {t("spending:whereIAm.createBudget")}
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
          title={t("spending:whereIAm.paceTitle", {
            pct: formatPercentValue(pace.percentPace * 100, { digits: 0 }),
          })}
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
  t: TFunction,
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
    ? t("spending:whereIAm.periodClosed", { count: totalDays })
    : daysRemaining === 0
      ? t("spending:whereIAm.lastDay")
      : t("spending:whereIAm.daysLeftIn", {
          days: t("spending:whereIAm.daysCount", { count: daysRemaining }),
          scope:
            range.months <= 1
              ? t("spending:whereIAm.inMonth", { month: formatMonthName(range.end) })
              : t("spending:whereIAm.inPeriod"),
        });

  // Narrative sentence. When the window is closed OR today is the last day,
  // there's nothing to project — describe the actual outcome instead.
  const isComplete = !isLive || daysRemaining === 0;
  const closeLabel =
    range.months <= 1 ? t("spending:whereIAm.monthEnd") : t("spending:whereIAm.periodClose");
  const narrative = isComplete
    ? buildClosedNarrative({ spent, target, currency, isBalanceHidden, t })
    : buildLiveNarrative({
        diffFromPace,
        projection,
        target,
        currency,
        closeLabel,
        isBalanceHidden,
        t,
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
  t,
}: {
  diffFromPace: number;
  projection: number;
  target: number;
  currency: string;
  closeLabel: string;
  isBalanceHidden: boolean;
  t: TFunction;
}): ReactNode {
  const direction =
    diffFromPace > 0 ? t("spending:whereIAm.overPace") : t("spending:whereIAm.underPace");
  const colorClass = diffFromPace > 0 ? "text-destructive" : "text-success";
  const projColorClass = projection > target ? "text-destructive" : "text-success";
  const pctOfBudget = target > 0 ? (projection / target) * 100 : 0;

  return (
    <div className="flex flex-col gap-1.5">
      <div
        className={cn("text-lg font-medium leading-tight tracking-tight md:text-xl", colorClass)}
      >
        <span className="tabular-nums">
          {isBalanceHidden ? "••••" : formatCompactAmount(Math.abs(diffFromPace), currency)}
        </span>{" "}
        <span className="font-serif">{direction}</span>
      </div>
      <div className="text-foreground/90 text-sm">
        {t("spending:whereIAm.projectedPrefix")}{" "}
        <span className={cn("font-medium tabular-nums", projColorClass)}>
          {isBalanceHidden ? "••••" : formatCompactAmount(projection, currency)}
        </span>{" "}
        {t("spending:whereIAm.byClose", { close: closeLabel })}
      </div>
      <div className="text-muted-foreground/80 text-xs tabular-nums">
        {t("spending:whereIAm.ofBudget", {
          pct: formatPercentValue(pctOfBudget, { digits: 0 }),
        })}
      </div>
    </div>
  );
}

function buildClosedNarrative({
  spent,
  target,
  currency,
  isBalanceHidden,
  t,
}: {
  spent: number;
  target: number;
  currency: string;
  isBalanceHidden: boolean;
  t: TFunction;
}): ReactNode {
  const diff = spent - target;
  const colorClass = diff > 0 ? "text-destructive" : "text-success";
  const pctOfBudget = target > 0 ? (spent / target) * 100 : 0;
  return (
    <div className="flex flex-col gap-1.5">
      <div
        className={cn("text-xl font-semibold tabular-nums tracking-tight md:text-2xl", colorClass)}
      >
        {t("spending:whereIAm.amountSpent", {
          amount: isBalanceHidden ? "••••" : formatCompactAmount(spent, currency),
        })}
      </div>
      <div className="text-foreground/90 text-sm">
        {t("spending:whereIAm.againstTarget", {
          target: isBalanceHidden ? "••••" : formatCompactAmount(target, currency),
        })}{" "}
        <span className={cn("font-medium", colorClass)}>
          {diff > 0 ? t("spending:whereIAm.overBy") : t("spending:whereIAm.underBy")}{" "}
          {isBalanceHidden ? "••••" : formatCompactAmount(Math.abs(diff), currency)}
        </span>
      </div>
      <div className="text-muted-foreground/80 text-xs tabular-nums">
        {t("spending:whereIAm.ofBudget", {
          pct: formatPercentValue(pctOfBudget, { digits: 0 }),
        })}
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
  const { t } = useTranslation();
  const { isBalanceHidden } = useBalancePrivacy();
  const segments = useMemo(
    () => buildShareSegments(breakdown, taxonomyCategories, spent, t),
    [breakdown, taxonomyCategories, spent, t],
  );

  const periodLabel =
    range.months <= 1
      ? t("spending:whereIAm.spentThisMonth")
      : range.months <= 3
        ? t("spending:whereIAm.spentThisPeriod")
        : t("spending:whereIAm.spentMonths", { months: range.months });

  const deltaPct =
    priorSpent != null && priorSpent > 0 ? ((spent - priorSpent) / priorSpent) * 100 : null;

  const priorLabel = useMemo(() => {
    if (range.months <= 1) {
      const prev = new Date(range.start);
      prev.setMonth(prev.getMonth() - 1);
      return t("spending:whereIAm.vsMonth", { month: formatMonthName(prev).slice(0, 3) });
    }
    return t("spending:whereIAm.vsPrior");
  }, [range, t]);

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
        <div className="text-foreground text-lg font-semibold tabular-nums tracking-tight md:text-xl">
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
                {t("spending:whereIAm.moreCount", { count: segments.length - 4 })}
              </span>
            )}
          </div>
        </>
      ) : (
        <div className="text-muted-foreground/70 mt-4 text-xs">
          {t("spending:hierarchy.noCategorizedSpending")}
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
  t: TFunction,
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
      name: t("spending:hero.other"),
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
  const { t } = useTranslation();
  const totals = useMemo(() => {
    let income = 0;
    let spent = 0;
    let saved = 0;
    for (const m of months) {
      income += m.report?.current.income ?? 0;
      spent += m.report?.current.outflow ?? 0;
      saved += m.report?.current.saved ?? 0;
    }
    const net = income - spent - saved;
    const surplusRate = income > 0 ? net / income : 0;
    return { income, spent, saved, net, surplusRate };
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

  const denom = Math.max(totals.income, totals.spent, totals.saved, 1);
  const incomePct = (totals.income / denom) * 100;
  const spentPct = (totals.spent / denom) * 100;
  const savedPct = (totals.saved / denom) * 100;
  const netToneClass = totals.net >= 0 ? "text-success" : "text-destructive";

  return (
    <div className={CARD_CLASS}>
      <div className="flex items-baseline justify-between">
        <div className={LABEL_CLASS}>{t("spending:whereIAm.netCashflow")}</div>
      </div>
      <div className="mt-2 flex items-baseline justify-between gap-2">
        <div
          className={cn(
            "text-lg font-semibold tabular-nums tracking-tight md:text-xl",
            netToneClass,
          )}
        >
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
              // Net >= 0 means money left after spending and explicit saving.
              // It is surplus/leftover cash, not the amount already saved.
              // Overspent → deficit as % of income ("by N%"). For deficits
              // greater than 100% of income the literal number ("Overspent
              // 250%") is misleading — cap the display at "by 100%+".
              const ratePct = Math.abs(totals.surplusRate) * 100;
              if (totals.net >= 0) {
                return t("spending:whereIAm.leftOver", {
                  pct: formatPercentValue(Math.min(100, ratePct), { digits: 0 }),
                });
              }
              return ratePct >= 100
                ? t("spending:whereIAm.overspentCapped")
                : t("spending:whereIAm.overspentBy", {
                    pct: formatPercentValue(ratePct, { digits: 0 }),
                  });
            })()}
          </span>
        )}
      </div>

      <div className="mt-4 space-y-2">
        <div className="flex items-center gap-2 text-[11px]">
          <span className="text-muted-foreground w-12 shrink-0">
            {t("spending:cashFlow.income")}
          </span>
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
            {t("spending:whereIAm.noIncome")}
          </p>
        )}
        <div className="flex items-center gap-2 text-[11px]">
          <span className="text-muted-foreground w-12 shrink-0">
            {t("spending:whereIAm.spent")}
          </span>
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
        {totals.saved > 0 && (
          <div className="flex items-center gap-2 text-[11px]">
            <span className="text-muted-foreground w-12 shrink-0">
              {t("spending:whereIAm.saved")}
            </span>
            <div className="bg-foreground/5 h-1.5 flex-1 overflow-hidden rounded-full">
              <div
                className="h-full rounded-full bg-[#6B8E54]/70 transition-all"
                style={{ width: `${savedPct}%` }}
              />
            </div>
            <span className="text-foreground/90 w-20 shrink-0 text-right font-semibold tabular-nums">
              <PrivacyAmount value={totals.saved} currency={currency} />
            </span>
          </div>
        )}
      </div>
    </div>
  );
};

// ═════════════════════════════════════════════════════════════════════════
// Cashflow detail — compact income/saving support for the headline card
// ═════════════════════════════════════════════════════════════════════════

interface CashflowOverviewProps {
  range: ReportsRange;
  currentReport: MonthlyReport | undefined;
  incomeCategories: TaxonomyCategory[];
  savingsCategories: TaxonomyCategory[];
  currency: string;
  isLoading: boolean;
}

function CashflowOverview({
  range,
  currentReport,
  incomeCategories,
  savingsCategories,
  currency,
  isLoading,
}: CashflowOverviewProps) {
  const { t } = useTranslation();
  const periodLabel = useMemo(() => buildPeriodSubtitle(range), [range]);
  const incomeRows = useMemo(
    () => buildCashflowRows(currentReport?.incomeBreakdown ?? [], incomeCategories, t),
    [currentReport?.incomeBreakdown, incomeCategories, t],
  );
  const savingsRows = useMemo(
    () => buildCashflowRows(currentReport?.savingsBreakdown ?? [], savingsCategories, t),
    [currentReport?.savingsBreakdown, savingsCategories, t],
  );
  const hasIncome = incomeRows.length > 0;
  const hasSaving = savingsRows.length > 0;

  if (!isLoading && !hasIncome && !hasSaving) return null;

  return (
    <section id="cashflow">
      <header className="mb-3">
        <h2 className="text-foreground text-base font-semibold tracking-tight">
          {t("spending:whereIAm.incomeSaving")}
        </h2>
        <p className="text-muted-foreground text-xs">
          {t("spending:whereIAm.nonSpendingCashflow", { period: periodLabel })}
        </p>
      </header>
      <div className="border-border/60 bg-card/40 overflow-hidden rounded-2xl border backdrop-blur-xl">
        {isLoading ? (
          <div className="grid gap-4 p-4 md:grid-cols-2">
            {Array.from({ length: 2 }).map((_, i) => (
              <div key={i} className="space-y-2">
                <Skeleton className="h-3 w-24" />
                <Skeleton className="h-8 w-full" />
                <Skeleton className="h-8 w-4/5" />
              </div>
            ))}
          </div>
        ) : (
          <div
            className={cn(
              "grid",
              hasIncome &&
                hasSaving &&
                "divide-border/40 divide-y md:grid-cols-2 md:divide-x md:divide-y-0",
            )}
          >
            {hasIncome && (
              <CashflowGroup
                label={t("spending:whereIAm.moneyIn")}
                sublabel={t("spending:whereIAm.incomeSources")}
                rows={incomeRows}
                currency={currency}
              />
            )}
            {hasSaving && (
              <CashflowGroup
                label={t("spending:whereIAm.setAside")}
                sublabel={t("spending:whereIAm.savingDestinations")}
                rows={savingsRows}
                currency={currency}
              />
            )}
          </div>
        )}
      </div>
    </section>
  );
}

interface CashflowGroupProps {
  label: string;
  sublabel: string;
  rows: CashflowRow[];
  currency: string;
}

function CashflowGroup({ label, sublabel, rows, currency }: CashflowGroupProps) {
  const { t } = useTranslation();
  const visibleRows = rows.slice(0, 4);
  const hiddenCount = Math.max(0, rows.length - visibleRows.length);

  return (
    <div className="p-4">
      <div className="mb-3">
        <div className={LABEL_CLASS}>{label}</div>
        <div className="text-muted-foreground/70 mt-0.5 text-xs">{sublabel}</div>
      </div>
      <div className="space-y-2">
        {visibleRows.map((row) => (
          <div key={row.id}>
            <div className="flex items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-2">
                <span
                  className="flex size-6 shrink-0 items-center justify-center rounded-full"
                  style={{
                    backgroundColor: `${row.color}24`,
                    color: row.color,
                  }}
                >
                  <CategoryIcon icon={row.icon} fallback={row.name} className="size-3" />
                </span>
                <span className="truncate text-sm font-medium">{row.name}</span>
              </div>
              <span className="text-sm font-semibold tabular-nums">
                <PrivacyAmount value={row.amount} currency={currency} />
              </span>
            </div>
            {visibleRows.length > 1 && (
              <div className="mt-2 flex items-center gap-2">
                <div className="bg-foreground/5 h-1 flex-1 overflow-hidden rounded-full">
                  <div
                    className="h-full rounded-full transition-all"
                    style={{
                      width: `${row.share}%`,
                      backgroundColor: row.color,
                    }}
                  />
                </div>
                <span className="text-muted-foreground/70 w-9 text-right text-[11px] tabular-nums">
                  {Math.round(row.share)}%
                </span>
              </div>
            )}
          </div>
        ))}
        {hiddenCount > 0 && (
          <div className="text-muted-foreground/70 text-xs tabular-nums">
            {t("spending:whereIAm.moreCount", { count: hiddenCount })}
          </div>
        )}
      </div>
    </div>
  );
}

interface CashflowRow {
  id: string;
  name: string;
  color: string;
  icon: string | null;
  amount: number;
  count: number;
  share: number;
}

function buildCashflowRows(
  breakdown: CategoryBreakdownRow[],
  taxonomyCategories: TaxonomyCategory[],
  t: TFunction,
): CashflowRow[] {
  const meta = new Map(taxonomyCategories.map((c) => [c.id, c]));
  const byTop = new Map<string, CashflowRow>();
  for (const row of breakdown) {
    if (row.amount === 0) continue;
    const topId =
      row.categoryId === "__uncategorized__" ? row.categoryId : topCategoryId(row.categoryId, meta);
    const top = meta.get(topId);
    const existing = byTop.get(topId) ?? {
      id: topId,
      name:
        topId === "__uncategorized__"
          ? t("spending:insightsPage.uncategorized")
          : (top?.name ?? topId),
      color: topId === "__uncategorized__" ? "#9CA3AF" : (top?.color ?? "#9CA3AF"),
      icon: top?.icon ?? null,
      amount: 0,
      count: 0,
      share: 0,
    };
    existing.amount += row.amount;
    existing.count += row.count;
    byTop.set(topId, existing);
  }

  const rows = Array.from(byTop.values()).sort((a, b) => b.amount - a.amount);
  const total = rows.reduce((sum, row) => sum + Math.max(0, row.amount), 0);
  return rows.map((row) => ({
    ...row,
    share: total > 0 ? (Math.max(0, row.amount) / total) * 100 : 0,
  }));
}

// ═════════════════════════════════════════════════════════════════════════
// Breakdown canvas — chips + sort + footer wrapping the table
// ═════════════════════════════════════════════════════════════════════════

type BreakdownFilter = "all" | "over" | "movers" | "no_budget";
type BreakdownSort = CategorySort;

const SORT_OPTIONS: BreakdownSort[] = ["spent", "delta", "name"];
const SORT_LABEL_KEYS: Record<BreakdownSort, string> = {
  spent: "spending:whereIAm.sortSpent",
  delta: "spending:whereIAm.sortChange",
  name: "spending:whereIAm.sortName",
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
  const { t } = useTranslation();
  const [filter, setFilter] = useState<BreakdownFilter>("all");
  const [sort, setSort] = useState<BreakdownSort>("spent");

  // Memoize these so downstream `counts`/`filteredBreakdown` memos stay valid
  // — otherwise a fresh array on every render busts memoization.
  const groupRows = useMemo(
    () => budget?.computed.groupRows.filter((row) => row.group.key !== SAVINGS_GROUP_KEY) ?? [],
    [budget],
  );
  const budgetRows = useMemo(() => groupRows.flatMap((row) => row.categories), [groupRows]);
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
      { id: "all", label: t("spending:whereIAm.filterAll"), count: counts.all },
      { id: "over", label: t("spending:whereIAm.filterOver"), count: counts.over },
      { id: "movers", label: t("spending:whereIAm.filterMovers"), count: counts.movers },
      { id: "no_budget", label: t("spending:whereIAm.filterNoBudget"), count: counts.noBudget },
    ],
    [counts, t],
  );

  return (
    <section id="breakdown">
      <header className="mb-3 flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 className="text-foreground text-base font-semibold tracking-tight">
            {t("spending:whereIAm.spendingPlan")}
          </h2>
          <p className="text-muted-foreground text-xs">
            {t("spending:whereIAm.budgetedByCategory", { period: periodLabel })}
          </p>
        </div>
        <div className="text-muted-foreground/80 hidden items-center gap-1.5 text-xs md:inline-flex">
          <span>{t("spending:whereIAm.sortBy")}</span>
          <DropdownMenu>
            <DropdownMenuTrigger
              aria-label={t("spending:whereIAm.sortByLabel", { label: t(SORT_LABEL_KEYS[sort]) })}
              className="bg-secondary text-foreground hover:bg-secondary/80 inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium tabular-nums focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--ring)]"
            >
              {t(SORT_LABEL_KEYS[sort])}
              <Icons.ChevronDown className="size-3 opacity-60" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-[140px]">
              {SORT_OPTIONS.map((opt) => (
                <DropdownMenuItem
                  key={opt}
                  onSelect={() => setSort(opt)}
                  className={cn("text-xs", sort === opt && "font-semibold")}
                >
                  {t(SORT_LABEL_KEYS[opt])}
                  {sort === opt && <Icons.Check className="ml-auto size-3" />}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      <div
        data-no-swipe-drag
        className="-mx-2 mb-3 flex touch-pan-x gap-2 overflow-x-auto overscroll-x-contain px-2 pb-1 md:mx-0 md:flex-wrap md:overflow-visible md:px-0 md:pb-0 [&::-webkit-scrollbar]:hidden"
      >
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
            {t("spending:whereIAm.categoriesShown", { shown: shownCats, total: totalCats })}
          </span>
          <Link
            to="/activities?tab=spending"
            className="text-foreground hover:text-foreground/80 inline-flex items-center gap-1 font-medium underline-offset-4 hover:underline"
          >
            {t("spending:whereIAm.openTransactions")}
          </Link>
        </div>
        {/* Mobile footer: count + low-emphasis link */}
        <div className="text-muted-foreground/80 mt-3 flex items-center justify-between gap-3 px-1 text-xs md:hidden">
          <span className="tabular-nums">
            {t("spending:whereIAm.categoriesShown", { shown: shownCats, total: totalCats })}
          </span>
          <Link
            to="/activities?tab=spending"
            className="text-foreground hover:text-foreground/80 inline-flex items-center gap-1 font-medium underline-offset-4 hover:underline"
          >
            {t("spending:whereIAm.openTransactions")}
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
  const sameMonth =
    range.start.getFullYear() === range.end.getFullYear() &&
    range.start.getMonth() === range.end.getMonth();
  const lastDayOfMonth = new Date(
    range.start.getFullYear(),
    range.start.getMonth() + 1,
    0,
  ).getDate();
  const isFullCalendarMonth =
    sameMonth && range.start.getDate() === 1 && range.end.getDate() === lastDayOfMonth;
  if (isFullCalendarMonth) return formatMonthName(range.start);
  if (range.days <= 45) return `${formatMonthDay(range.start)} → ${formatMonthDay(range.end)}`;
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
