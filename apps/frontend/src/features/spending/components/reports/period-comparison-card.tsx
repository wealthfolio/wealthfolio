import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { Skeleton, formatCompactAmount } from "@wealthfolio/ui";
import { useBalancePrivacy } from "@/hooks/use-balance-privacy";
import { cn } from "@/lib/utils";

import { type ComparisonMode } from "../../lib/reports-period";
import type { MonthlyReport } from "../../types/report";

interface PeriodComparisonCardProps {
  current: MonthlyReport | undefined;
  prior: MonthlyReport | undefined;
  comparison: ComparisonMode;
  currency: string;
  isLoading: boolean;
}

interface MetricRow {
  key: "income" | "spending" | "net" | "rate";
  label: string;
  currentValue: number;
  priorValue: number;
  /** Direction in which "going up" is good. */
  goodOnIncrease: boolean;
}

/**
 * Period-over-period comparison block.
 * Renders four KPIs (income, spending, net, savings rate) with current value,
 * prior value, absolute delta, and % delta. Sign + tone follow `goodOnIncrease`
 * — for spending, going up is bad; for income/net/savings rate, going up is good.
 */
export function PeriodComparisonCard({
  current,
  prior,
  comparison,
  currency,
  isLoading,
}: PeriodComparisonCardProps) {
  const { t } = useTranslation();
  const rows: MetricRow[] = useMemo(() => {
    const c = current?.current;
    const p = prior?.current;
    const cIn = c?.income ?? 0;
    const cOut = c?.outflow ?? 0;
    const cNet = cIn - cOut;
    const cRate = cIn > 0 ? cNet / cIn : 0;
    const pIn = p?.income ?? 0;
    const pOut = p?.outflow ?? 0;
    const pNet = pIn - pOut;
    const pRate = pIn > 0 ? pNet / pIn : 0;
    return [
      {
        key: "income" as const,
        label: t("spending:cashFlow.income"),
        currentValue: cIn,
        priorValue: pIn,
        goodOnIncrease: true,
      },
      {
        key: "spending" as const,
        label: t("spending:cashFlow.spending"),
        currentValue: cOut,
        priorValue: pOut,
        goodOnIncrease: false,
      },
      {
        key: "net" as const,
        label: t("spending:comparison.netSavings"),
        currentValue: cNet,
        priorValue: pNet,
        goodOnIncrease: true,
      },
      {
        key: "rate" as const,
        label: t("spending:comparison.savingsRate"),
        currentValue: cRate,
        priorValue: pRate,
        goodOnIncrease: true,
      },
    ];
  }, [current, prior, t]);

  if (isLoading) {
    return (
      <div className="border-border bg-card shadow-xs grid grid-cols-2 gap-4 rounded-xl border p-4 md:grid-cols-4 md:p-5">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-16 w-full rounded-md" />
        ))}
      </div>
    );
  }

  return (
    <div className="border-border bg-card shadow-xs rounded-xl border p-4 md:p-5">
      <div className="mb-3 flex items-baseline justify-between">
        <h3 className="text-foreground text-sm font-semibold">
          {t("spending:comparison.versus", {
            label: t(`spending:comparison.mode.${comparison}`).toLowerCase(),
          })}
        </h3>
      </div>
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        {rows.map((r) => (
          <ComparisonMetric key={r.key} row={r} currency={currency} />
        ))}
      </div>
    </div>
  );
}

function ComparisonMetric({ row, currency }: { row: MetricRow; currency: string }) {
  const { t } = useTranslation();
  const { isBalanceHidden } = useBalancePrivacy();
  const { currentValue, priorValue, goodOnIncrease, label } = row;
  const isRate = row.key === "rate";
  const delta = currentValue - priorValue;
  const pct = priorValue !== 0 ? delta / Math.abs(priorValue) : null;

  const trendingUp = delta > 0;
  const positiveTone = goodOnIncrease ? trendingUp : !trendingUp;
  const toneClass =
    delta === 0 || priorValue === 0
      ? "text-muted-foreground"
      : positiveTone
        ? "text-success"
        : "text-destructive";

  return (
    <div className="flex flex-col">
      <span className="text-muted-foreground text-[11px] font-light tracking-wide">{label}</span>
      <span className="text-foreground text-base font-semibold tabular-nums">
        {isBalanceHidden ? "••••" : formatMetric(currentValue, currency, isRate)}
      </span>
      {!isBalanceHidden && pct != null && (
        <span className={cn("mt-0.5 text-[11px] tabular-nums", toneClass)}>
          {trendingUp ? "↑" : delta < 0 ? "↓" : "→"} {Math.abs(pct * 100).toFixed(1)}%
          <span className="text-muted-foreground/70 ml-1 font-normal">
            {t("spending:comparison.was", {
              value: formatMetric(priorValue, currency, isRate),
            })}
          </span>
        </span>
      )}
    </div>
  );
}

function formatMetric(value: number, currency: string, isRate: boolean): string {
  if (isRate) return `${(value * 100).toFixed(1)}%`;
  return formatCompactAmount(value, currency);
}
