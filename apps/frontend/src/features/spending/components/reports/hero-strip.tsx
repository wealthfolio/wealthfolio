import { useMemo, type FC } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";

import { PrivacyAmount, Skeleton, formatCompactAmount } from "@wealthfolio/ui";
import { useBalancePrivacy } from "@/hooks/use-balance-privacy";
import type { TaxonomyCategory } from "@/lib/types";
import { cn, formatAmount } from "@/lib/utils";

import type { BudgetSnapshot } from "../../types/budget";
import type { CategoryBreakdownRow, MonthBucket } from "../../types/report";

// ─── shared chrome ────────────────────────────────────────────────────────

const CARD_CLASS = "border-border bg-card shadow-xs rounded-xl border p-4 md:p-5";

const LABEL_CLASS = "text-muted-foreground/70 text-[10px] font-semibold uppercase tracking-wide";

function HeroSection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className={CARD_CLASS}>
      <div className={LABEL_CLASS}>{label}</div>
      <div className="mt-2">{children}</div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Period summary — big total + horizontal stacked share bar
// ═══════════════════════════════════════════════════════════════════════════

interface PeriodSummaryHeroProps {
  spent: number;
  /** Days in active range. */
  days: number;
  /** Months in active range. */
  months: number;
  breakdown: CategoryBreakdownRow[];
  taxonomyCategories: TaxonomyCategory[];
  currency: string;
  isLoading: boolean;
}

interface ShareSegment {
  id: string;
  name: string;
  color: string;
  amount: number;
  share: number;
}

export const PeriodSummaryHero: FC<PeriodSummaryHeroProps> = ({
  spent,
  days,
  months,
  breakdown,
  taxonomyCategories,
  currency,
  isLoading,
}) => {
  const { t } = useTranslation();
  const segments = useMemo<ShareSegment[]>(
    () => buildShareSegments(breakdown, taxonomyCategories, spent, t),
    [breakdown, taxonomyCategories, spent, t],
  );

  const { isBalanceHidden } = useBalancePrivacy();
  const periodSubtitle =
    months >= 2
      ? t("spending:hero.periodMonthsDays", { months, days })
      : t("spending:hero.periodDays", { count: days });
  const dailyAvg = days > 0 ? spent / days : 0;

  if (isLoading) {
    return (
      <div className={CARD_CLASS}>
        <Skeleton className="h-3 w-32" />
        <Skeleton className="mt-2 h-9 w-48" />
        <Skeleton className="mt-4 h-2 w-full rounded-full" />
        <Skeleton className="mt-3 h-4 w-3/4" />
      </div>
    );
  }

  return (
    <HeroSection label={t("spending:hero.periodSummary", { subtitle: periodSubtitle })}>
      <div className="text-foreground text-3xl font-bold tabular-nums tracking-tight">
        <PrivacyAmount value={spent} currency={currency} />
      </div>
      <div className="text-muted-foreground/80 text-xs">
        {t("spending:hero.totalSpent")} ·{" "}
        <span className="text-foreground/90 font-semibold">
          {isBalanceHidden ? "••••" : formatCompactAmount(dailyAvg, currency)}
        </span>{" "}
        {t("spending:hero.perDayAvg")}
      </div>

      {/* Stacked share bar */}
      {segments.length > 0 ? (
        <>
          <div className="bg-muted/40 relative mt-4 flex h-2 w-full overflow-hidden rounded-full">
            {segments.map((s, i) => (
              <div
                key={s.id}
                className="h-full"
                style={{
                  width: `${s.share}%`,
                  backgroundColor: s.color,
                  opacity: 0.9,
                  borderRight: i < segments.length - 1 ? "1px solid var(--card)" : undefined,
                }}
                title={`${s.name} · ${
                  isBalanceHidden ? "••••" : formatAmount(s.amount, currency)
                } (${s.share.toFixed(1)}%)`}
              />
            ))}
          </div>
          <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
            {segments.slice(0, 4).map((s) => (
              <span key={s.id} className="flex items-center gap-1.5 text-[11px]">
                <span
                  className="block h-1.5 w-1.5 rounded-full"
                  style={{ backgroundColor: s.color }}
                />
                <span className="text-muted-foreground/90">{s.name}</span>
                <span className="text-muted-foreground/60 tabular-nums">
                  {Math.round(s.share)}%
                </span>
              </span>
            ))}
          </div>
        </>
      ) : (
        <div className="text-muted-foreground/70 mt-4 text-xs">
          {t("spending:hero.noCategorizedSpending")}
        </div>
      )}
    </HeroSection>
  );
};

function buildShareSegments(
  breakdown: CategoryBreakdownRow[],
  taxonomyCategories: TaxonomyCategory[],
  total: number,
  t: TFunction,
): ShareSegment[] {
  if (total <= 0) return [];
  const meta = new Map(taxonomyCategories.map((c) => [c.id, c]));

  // Roll subcategory amounts up to top-level for cleaner segmentation.
  const byTop = new Map<string, { name: string; color: string | null; amount: number }>();
  for (const r of breakdown) {
    const m = meta.get(r.categoryId);
    const topId = m?.parentId ?? r.categoryId;
    const top = meta.get(topId) ?? m;
    if (!top) continue;
    const e = byTop.get(topId) ?? { name: top.name, color: top.color ?? null, amount: 0 };
    e.amount += r.amount;
    byTop.set(topId, e);
  }

  const sorted = Array.from(byTop.entries())
    .map(([id, e]) => ({
      id,
      name: e.name,
      color: e.color ?? "#9CA3AF",
      amount: e.amount,
      share: (e.amount / total) * 100,
    }))
    .sort((a, b) => b.amount - a.amount);

  // Cap to top 6 segments + "Other" for cleanliness on the bar.
  const top = sorted.slice(0, 6);
  const restAmount = sorted.slice(6).reduce((s, x) => s + x.amount, 0);
  if (restAmount > 0) {
    top.push({
      id: "__other__",
      name: t("spending:hero.other"),
      color: "#9CA3AF",
      amount: restAmount,
      share: (restAmount / total) * 100,
    });
  }
  return top;
}

// ═══════════════════════════════════════════════════════════════════════════
// Budget status — half-arc gauge, % hero, pace/forecast footer
// ═══════════════════════════════════════════════════════════════════════════

interface BudgetStatusHeroProps {
  spent: number;
  /** Months covered by the active range — drives target × N. */
  monthsInRange: number;
  budget: BudgetSnapshot | undefined;
  /** Historical 3-mo daily avg used for forecast. */
  historicalDailyAvg?: number;
  currency: string;
  isLoading: boolean;
}

export const BudgetStatusHero: FC<BudgetStatusHeroProps> = ({
  spent,
  monthsInRange,
  budget,
  historicalDailyAvg = 0,
  currency,
  isLoading,
}) => {
  const { t } = useTranslation();
  const monthlyTarget = budget?.computed.totals.spendingPlanned ?? 0;
  const target = monthlyTarget * Math.max(1, monthsInRange);
  const pct = target > 0 ? spent / target : 0;
  const isOver = pct > 1;

  // Pace target — assume linear pacing across the active range. We approximate
  // "how much should I have spent by now" as the elapsed fraction of the range.
  // Without exact range bounds in the prop set we use months-completion as proxy.
  const today = new Date();
  const dayOfMonth = today.getDate();
  const daysInThisMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
  const monthsFraction = monthsInRange > 1 ? 1 : dayOfMonth / daysInThisMonth; // single-month windows: linear within month
  const paceTarget = monthsFraction;

  // Forecast: historical 3-mo daily avg × days in range, fallback to linear extrapolation
  const daysInRange = Math.round(daysInThisMonth * monthsInRange);
  const forecast =
    historicalDailyAvg > 0
      ? historicalDailyAvg * daysInRange
      : pct > 0
        ? (spent / Math.max(1, dayOfMonth)) * daysInRange
        : 0;

  const { isBalanceHidden } = useBalancePrivacy();
  const overBy = spent - target;
  const remaining = target - spent;

  if (isLoading) {
    return (
      <div className={CARD_CLASS}>
        <Skeleton className="h-3 w-32" />
        <Skeleton className="mt-3 h-[88px] w-full" />
        <Skeleton className="mt-3 h-4 w-2/3" />
      </div>
    );
  }

  if (monthlyTarget <= 0) {
    return (
      <HeroSection label={t("spending:hero.budgetStatus")}>
        <p className="text-muted-foreground text-sm">{t("spending:overallBudget.noTarget")}</p>
      </HeroSection>
    );
  }

  const status = isOver ? "over" : pct >= 0.85 ? "approach" : "ok";
  const fillColor =
    status === "over"
      ? "var(--destructive)"
      : status === "approach"
        ? "var(--status-warn)"
        : "var(--success)";
  const statusLabel = isOver
    ? t("spending:hero.overBudget")
    : pct >= 0.85
      ? t("spending:hero.trendingHigh")
      : t("spending:hero.onTrack");

  // Pace marker position (clamped 0–100% of bar width).
  const pacePct = Math.min(1, Math.max(0, paceTarget));
  // Visible bar fill — capped at 100% so it never overshoots the track visually.
  const fillPct = Math.min(1, pct);

  const monthsLabel =
    monthsInRange === 1
      ? t("spending:hero.thisMonth")
      : t("spending:hero.monthsCount", { count: monthsInRange });

  return (
    <HeroSection label={t("spending:hero.budgetStatusWith", { label: monthsLabel })}>
      <div className="flex items-baseline justify-between gap-2">
        <div className="text-foreground text-3xl font-bold tabular-nums tracking-tight">
          {Math.round(pct * 100)}%
        </div>
        <span
          className="rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
          style={{ backgroundColor: `${fillColor}1F`, color: fillColor }}
        >
          {statusLabel}
        </span>
      </div>
      <div className="text-muted-foreground/80 mt-1 text-xs tabular-nums">
        {isBalanceHidden ? "••••" : formatCompactAmount(spent, currency)} {t("spending:hero.of")}{" "}
        {isBalanceHidden ? "••••" : formatCompactAmount(target, currency)}
      </div>

      {/* Horizontal progress with pace marker */}
      <div className="bg-foreground/10 relative mt-4 h-2 w-full overflow-hidden rounded-full">
        <div
          className="h-full rounded-full transition-all"
          style={{
            width: `${fillPct * 100}%`,
            backgroundColor: fillColor,
            opacity: 0.65,
          }}
        />
        {/* Pace target tick — vertical line on the bar */}
        <div
          className="bg-foreground/60 absolute top-0 h-full w-px"
          style={{ left: `${pacePct * 100}%` }}
          title={t("spending:hero.paceTarget", { pct: Math.round(paceTarget * 100) })}
        />
      </div>

      {/* Compact stat row: remaining/over + forecast vs target */}
      <div className="text-muted-foreground/80 mt-3 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-[11px]">
        <span className={cn("tabular-nums", isOver ? "text-destructive" : "text-success")}>
          {isOver ? t("spending:hero.overBy") : t("spending:hero.remaining")}{" "}
          <span className="font-semibold">
            {isBalanceHidden
              ? "••••"
              : formatCompactAmount(Math.abs(isOver ? overBy : remaining), currency)}
          </span>
        </span>
        <span
          className={cn("tabular-nums", forecast > target ? "text-destructive" : "text-success")}
        >
          {t("spending:hero.forecast")}{" "}
          <span className="font-semibold">
            {isBalanceHidden ? "••••" : formatCompactAmount(forecast, currency)}
          </span>
          {forecast > 0 && (
            <span className="ml-1">
              (
              {isBalanceHidden
                ? "••••"
                : forecast > target
                  ? `+${formatCompactAmount(forecast - target, currency)}`
                  : `−${formatCompactAmount(target - forecast, currency)}`}
              )
            </span>
          )}
        </span>
      </div>
    </HeroSection>
  );
};

// ═══════════════════════════════════════════════════════════════════════════
// Cashflow — Income / Spent / Saved KPIs + mini per-month bars
// ═══════════════════════════════════════════════════════════════════════════

interface CashflowHeroProps {
  months: MonthBucket[];
  currency: string;
  isLoading: boolean;
}

export const CashflowHero: FC<CashflowHeroProps> = ({ months, currency, isLoading }) => {
  const { t } = useTranslation();
  const { isBalanceHidden } = useBalancePrivacy();
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
        <Skeleton className="h-3 w-32" />
        <Skeleton className="mt-3 h-9 w-2/3" />
        <Skeleton className="mt-3 h-3 w-1/2" />
      </div>
    );
  }

  const periodLabel = t("spending:hero.monthsCount", { count: months.length });
  const monthlyAvgNet = months.length > 0 ? totals.net / months.length : 0;

  // Width proportions for the income/spent bar — relative to the larger of the
  // two so the longer bar always reaches the right edge.
  const denom = Math.max(totals.income, totals.spent, 1);
  const incomePct = (totals.income / denom) * 100;
  const spentPct = (totals.spent / denom) * 100;
  const netLabel = totals.net >= 0 ? t("spending:hero.saved") : t("spending:hero.overspent");
  const netToneClass = totals.net >= 0 ? "text-success" : "text-destructive";

  return (
    <HeroSection label={t("spending:hero.cashflowWith", { label: periodLabel })}>
      <div className="flex items-baseline justify-between gap-2">
        <div className={cn("text-3xl font-bold tabular-nums tracking-tight", netToneClass)}>
          {totals.net >= 0 ? "+" : "−"}
          {isBalanceHidden ? "••••" : formatCompactAmount(Math.abs(totals.net), currency)}
        </div>
        {totals.income > 0 && (
          <span
            className={cn(
              "rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
              totals.net >= 0 ? "bg-success/15 text-success" : "bg-destructive/15 text-destructive",
            )}
          >
            {netLabel} {Math.round(Math.abs(totals.savingsRate) * 100)}%
          </span>
        )}
      </div>
      <div className="text-muted-foreground/80 mt-1 text-xs">
        {t("spending:hero.netPeriod", { label: periodLabel.toLowerCase() })}
      </div>

      {/* Income / Spent proportion bars */}
      <div className="mt-4 space-y-1.5">
        <div className="flex items-center gap-2">
          <span className="text-success w-20 shrink-0 text-[11px] font-semibold tabular-nums">
            +{isBalanceHidden ? "••••" : formatCompactAmount(totals.income, currency)}
          </span>
          <div className="bg-foreground/10 h-1.5 flex-1 overflow-hidden rounded-full">
            <div
              className="bg-success/65 h-full rounded-full transition-all"
              style={{ width: `${incomePct}%` }}
            />
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-destructive w-20 shrink-0 text-[11px] font-semibold tabular-nums">
            −{isBalanceHidden ? "••••" : formatCompactAmount(totals.spent, currency)}
          </span>
          <div className="bg-foreground/10 h-1.5 flex-1 overflow-hidden rounded-full">
            <div
              className="bg-destructive/65 h-full rounded-full transition-all"
              style={{ width: `${spentPct}%` }}
            />
          </div>
        </div>
      </div>

      <div className="text-muted-foreground/80 mt-3 text-[11px]">
        {t("spending:hero.avgNet")} ·{" "}
        <span
          className={cn(
            "font-semibold tabular-nums",
            monthlyAvgNet >= 0 ? "text-success" : "text-destructive",
          )}
        >
          {monthlyAvgNet >= 0 ? "+" : "−"}
          {isBalanceHidden ? "••••" : formatCompactAmount(Math.abs(monthlyAvgNet), currency)}
        </span>{" "}
        {t("spending:hero.perMonth")}
      </div>
    </HeroSection>
  );
};
