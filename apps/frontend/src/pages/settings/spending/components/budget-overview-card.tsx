import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

import { Button, Icons } from "@wealthfolio/ui";

import { useBudget } from "@/features/spending/hooks/use-budget";
import { useBalancePrivacy } from "@/hooks/use-balance-privacy";
import { cn } from "@/lib/utils";

import { formatAmountWhole } from "./format";

export function BudgetOverviewCard() {
  const { t } = useTranslation();
  const { data: budget, isLoading } = useBudget();
  const { isBalanceHidden } = useBalancePrivacy();
  const fmt = (amount: number, currency: string) =>
    isBalanceHidden ? "••••" : formatAmountWhole(amount, currency);

  const spendingPlanned = budget?.computed.totals.spendingPlanned ?? 0;
  const incomePlanned = budget?.computed.totals.incomePlanned ?? 0;
  const currency = budget?.computed.currency ?? "USD";

  const groups = useMemo(() => {
    return (budget?.computed.groupRows ?? []).map((row) => ({
      id: row.group.id,
      name: row.group.name,
      color: row.group.color,
      planned: row.plannedTotal,
    }));
  }, [budget?.computed.groupRows]);

  const fundedGroups = groups.filter((g) => g.planned > 0);
  const unfundedGroups = groups.filter((g) => g.planned <= 0);
  const totalPlanned = fundedGroups.reduce((sum, g) => sum + g.planned, 0) || 1;

  const pctOfIncome =
    incomePlanned > 0 ? Math.round((spendingPlanned / incomePlanned) * 100) : null;
  const isOver = pctOfIncome !== null && pctOfIncome > 100;

  const isEmpty = !isLoading && spendingPlanned <= 0 && incomePlanned <= 0;

  if (isLoading) {
    return <div className="bg-muted/40 h-44 w-full animate-pulse rounded-lg" />;
  }

  if (isEmpty) {
    return (
      <div className="bg-card rounded-lg border p-6">
        <div className="space-y-3">
          <div>
            <h3 className="text-base font-semibold">
              {t("settings:spending.budget_overview.title")}
            </h3>
            <p className="text-muted-foreground mt-1 text-xs">
              {t("settings:spending.budget_overview.empty_description")}
            </p>
          </div>
          <Button asChild size="sm">
            <Link to="/settings/spending/setup">
              <Icons.Plus className="mr-1.5 h-3.5 w-3.5" />
              {t("settings:spending.budget_overview.setup_cta")}
            </Link>
          </Button>
        </div>
      </div>
    );
  }

  return (
    <Link
      to="/settings/spending/setup"
      aria-label={t("settings:spending.budget_overview.open_aria")}
      className="bg-card hover:border-foreground/20 group flex flex-col items-stretch overflow-hidden rounded-lg border transition-all hover:shadow-md sm:flex-row"
    >
      <div className="min-w-0 flex-1 p-6">
        <div className="mb-4">
          <h3 className="text-base font-semibold tracking-tight">
            {t("settings:spending.budget_overview.title")}
          </h3>
          <p className="text-muted-foreground mt-1 text-xs">
            {t("settings:spending.budget_overview.description")}
          </p>
        </div>

        <div className="mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <div>
            <div className="tabular-nums leading-none">
              <span className="text-foreground text-xl font-semibold tracking-tight sm:text-2xl">
                {fmt(spendingPlanned, currency)}
              </span>
              {incomePlanned > 0 && (
                <span className="text-muted-foreground ml-1 text-sm font-normal sm:text-base">
                  / {fmt(incomePlanned, currency)}
                </span>
              )}
            </div>
            <div className="text-muted-foreground mt-1.5 text-[10px] font-medium uppercase tracking-widest">
              {incomePlanned > 0
                ? t("settings:spending.budget_overview.planned_vs_income")
                : t("settings:spending.budget_overview.planned_spending")}
            </div>
          </div>
          {pctOfIncome !== null && (
            <span
              className={cn(
                "inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1.5 text-xs font-medium",
                isOver ? "bg-destructive/15 text-destructive" : "bg-success/15 text-success",
              )}
            >
              <Icons.AlertCircle className="h-3 w-3" />
              {t("settings:spending.budget_overview.pct_of_income", { pct: pctOfIncome })}
            </span>
          )}
        </div>

        {fundedGroups.length > 0 && (
          <div className="mb-3.5 flex h-2 w-full gap-0.5 overflow-hidden rounded">
            {fundedGroups.map((g) => (
              <span
                key={g.id}
                className="block h-full"
                style={{
                  width: `${(g.planned / totalPlanned) * 100}%`,
                  background: g.color ?? "var(--muted-foreground)",
                }}
              />
            ))}
          </div>
        )}

        <div className="flex flex-wrap gap-x-3.5 gap-y-1 text-xs">
          {fundedGroups.map((g) => (
            <span key={g.id} className="inline-flex items-center gap-1.5 py-0.5">
              <span
                className="h-2 w-2 rounded-sm"
                style={{ background: g.color ?? "var(--muted-foreground)" }}
              />
              <span className="text-foreground font-medium">{g.name}</span>
              <span className="text-muted-foreground tabular-nums">{fmt(g.planned, currency)}</span>
            </span>
          ))}
          {unfundedGroups.map((g) => (
            <span
              key={g.id}
              className="text-muted-foreground inline-flex items-center gap-1.5 py-0.5"
            >
              <span
                className="h-2 w-2 rounded-sm opacity-40"
                style={{ background: g.color ?? "var(--muted-foreground)" }}
              />
              <span>{g.name}</span>
              <span>—</span>
            </span>
          ))}
        </div>
      </div>

      {/* CTA — bottom bar on mobile, right rail on desktop */}
      <div className="bg-muted/30 group-hover:bg-foreground group-hover:text-background text-muted-foreground flex shrink-0 items-center justify-center gap-1.5 border-t px-4 py-3 text-xs font-medium uppercase tracking-widest transition-colors sm:w-24 sm:flex-col sm:gap-2 sm:border-l sm:border-t-0 sm:px-0 sm:py-0">
        <span>{t("settings:spending.budget_overview.open")}</span>
        <Icons.ChevronRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
      </div>
    </Link>
  );
}
