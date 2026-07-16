import { useMemo } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { PrivacyAmount, Skeleton, formatCompactAmount } from "@wealthfolio/ui";
import { useBalancePrivacy } from "@/hooks/use-balance-privacy";
import { cn } from "@/lib/utils";

import type { BudgetSnapshot } from "../../types/budget";

interface OverallBudgetMeterProps {
  /** Total spending across the active reports range. */
  spent: number;
  /** Number of full months covered by the active range. Drives budget × N. */
  monthsInRange: number;
  budget: BudgetSnapshot | undefined;
  currency: string;
  isLoading: boolean;
}

/**
 * Period-scoped budget meter. Multiplies the configured monthly target by the
 * number of months in the active window so a 6M view compares 6× monthly
 * budget against 6 months of actual spend. Complements (does not duplicate)
 * the dashboard's "this month" gauge.
 */
export function OverallBudgetMeter({
  spent,
  monthsInRange,
  budget,
  currency,
  isLoading,
}: OverallBudgetMeterProps) {
  const { t } = useTranslation();
  const { isBalanceHidden } = useBalancePrivacy();
  const monthlyTarget = budget?.computed.totals.spendingPlanned ?? 0;
  const targetForRange = monthlyTarget * Math.max(1, monthsInRange);
  const pct = targetForRange > 0 ? spent / targetForRange : 0;

  const status = useMemo<"over" | "approaching" | "comfortable">(() => {
    if (pct > 1) return "over";
    if (pct >= 0.85) return "approaching";
    return "comfortable";
  }, [pct]);

  if (isLoading) {
    return <Skeleton className="h-[88px] w-full rounded-xl" />;
  }

  if (monthlyTarget <= 0) {
    return (
      <div className="border-border bg-card shadow-xs rounded-xl border p-4 text-center md:p-5">
        <p className="text-muted-foreground text-sm">{t("spending:overallBudget.noTarget")}</p>
        <Link
          to="/settings/spending/setup"
          className="text-muted-foreground hover:text-foreground mt-2 inline-flex items-center gap-1 text-xs underline-offset-4 hover:underline"
        >
          {t("spending:overallBudget.setBudget")}
        </Link>
      </div>
    );
  }

  const fillPct = Math.min(100, pct * 100);
  const overflowPct = pct > 1 ? Math.min(100, (pct - 1) * 100) : 0;
  const remaining = Math.max(0, targetForRange - spent);
  const overage = Math.max(0, spent - targetForRange);
  const isOver = status === "over";

  const fillColor =
    status === "over"
      ? "var(--destructive)"
      : status === "approaching"
        ? "var(--status-warn)"
        : "var(--success)";

  return (
    <div className="border-border bg-card shadow-xs rounded-xl border p-4 md:p-5">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <div>
          <h3 className="text-foreground text-sm font-semibold">
            {t("spending:overallBudget.title")}
          </h3>
          <p className="text-muted-foreground/70 text-xs tabular-nums">
            <PrivacyAmount value={monthlyTarget} currency={currency} />
            {t("spending:overallBudget.perMonthTimes", { count: monthsInRange })}
          </p>
        </div>
        <div className="text-right">
          <div className="text-foreground text-xl font-semibold tabular-nums">
            {Math.round(pct * 100)}%
          </div>
          <div
            className={cn(
              "text-[11px] font-medium tabular-nums",
              isOver ? "text-destructive" : "text-success",
            )}
          >
            {isBalanceHidden
              ? "••••"
              : isOver
                ? t("spending:overallBudget.overAmount", {
                    amount: formatCompactAmount(overage, currency),
                  })
                : t("spending:overallBudget.leftAmount", {
                    amount: formatCompactAmount(remaining, currency),
                  })}
          </div>
        </div>
      </div>

      <div className="bg-muted/40 relative h-2.5 w-full overflow-hidden rounded-full">
        <div
          className="h-full rounded-full transition-all"
          style={{ width: `${fillPct}%`, backgroundColor: fillColor, opacity: 0.95 }}
        />
        {overflowPct > 0 && (
          <div
            className="absolute inset-y-0 right-0 rounded-r-full"
            style={{
              width: `${overflowPct}%`,
              backgroundColor: "var(--destructive)",
              opacity: 0.5,
              backgroundImage:
                "repeating-linear-gradient(135deg, var(--bar-stripe) 0 4px, transparent 4px 8px)",
            }}
          />
        )}
      </div>

      <div className="text-muted-foreground/70 mt-1.5 flex justify-between text-[11px] tabular-nums">
        <span>
          <PrivacyAmount value={spent} currency={currency} /> {t("spending:overallBudget.spent")}
        </span>
        <span>
          <PrivacyAmount value={targetForRange} currency={currency} />{" "}
          {t("spending:overallBudget.target")}
        </span>
      </div>
    </div>
  );
}
