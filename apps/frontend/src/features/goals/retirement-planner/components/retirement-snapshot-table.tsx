import type { RetirementTrajectoryPoint } from "@/lib/types";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  formatAmount,
  formatCompactAmount,
} from "@wealthfolio/ui";
import { Icons } from "@wealthfolio/ui/components/ui/icons";
import { useState } from "react";
import { useTranslation } from "react-i18next";

const PAGE_SIZE = 10;

function SnapshotAmount({
  value,
  age,
  currency,
  scaleForModeAtAge,
  compact = false,
  empty = "—",
}: {
  value: number;
  age: number;
  currency: string;
  scaleForModeAtAge: (value: number, age: number) => number;
  compact?: boolean;
  empty?: string;
}) {
  if (value <= 0) return empty;
  const scaledValue = scaleForModeAtAge(value, age);
  return compact ? formatCompactAmount(scaledValue, currency) : formatAmount(scaledValue, currency);
}

export function RetirementSnapshotTable({
  snapshots,
  hasPensionFunds,
  incomeStartAges,
  fiAge,
  phaseLabel,
  currency,
  scaleForModeAtAge,
}: {
  snapshots: RetirementTrajectoryPoint[];
  hasPensionFunds: boolean;
  incomeStartAges: Set<number>;
  fiAge: number | null;
  phaseLabel: string;
  currency: string;
  scaleForModeAtAge: (value: number, age: number) => number;
}) {
  const { t } = useTranslation();
  const [tablePage, setTablePage] = useState(0);
  const totalPages = Math.ceil(snapshots.length / PAGE_SIZE);
  const pagedSnapshots = snapshots.slice(tablePage * PAGE_SIZE, (tablePage + 1) * PAGE_SIZE);

  if (snapshots.length === 0) return null;

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between pb-3">
        <div>
          <div className="text-muted-foreground mb-0.5 text-[10px] font-semibold uppercase tracking-wider">
            {t("goals:snapshot.table")}
          </div>
          <CardTitle className="text-sm">{t("goals:snapshot.title")}</CardTitle>
          {hasPensionFunds && (
            <p className="text-muted-foreground mt-1 text-xs">{t("goals:snapshot.pension_note")}</p>
          )}
        </div>
        {totalPages > 1 && (
          <div className="flex items-center gap-1.5">
            <span className="text-muted-foreground text-xs">
              {tablePage + 1} / {totalPages}
            </span>
            <Button
              variant="outline"
              size="icon"
              className="h-7 w-7"
              onClick={() => setTablePage((p) => Math.max(0, p - 1))}
              disabled={tablePage === 0}
            >
              <Icons.ChevronLeft className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="outline"
              size="icon"
              className="h-7 w-7"
              onClick={() => setTablePage((p) => Math.min(totalPages - 1, p + 1))}
              disabled={tablePage >= totalPages - 1}
            >
              <Icons.ChevronRight className="h-3.5 w-3.5" />
            </Button>
          </div>
        )}
      </CardHeader>
      <CardContent>
        <div className="overflow-hidden rounded-lg border md:hidden">
          {pagedSnapshots.map((snap) => {
            const isFire = snap.phase === "fire";
            const isFireRow = snap.age === fiAge;
            const isIncomeRow = incomeStartAges.has(snap.age);
            const plannedSpending = snap.plannedExpenses ?? snap.annualExpenses;
            const rowClassName = isFireRow
              ? "border-l-green-500 bg-green-50/70 dark:bg-green-950/20"
              : isIncomeRow
                ? "border-l-blue-500 bg-blue-50/70 dark:bg-blue-950/20"
                : "border-l-transparent bg-background/40";
            const phaseText = isFire ? phaseLabel : t("goals:snapshot.phase_acc");
            const mobileMetrics = [
              { label: t("goals:snapshot.metric_contrib"), value: snap.annualContribution },
              { label: t("goals:snapshot.metric_income"), value: snap.annualIncome },
              { label: t("goals:snapshot.metric_spend"), value: plannedSpending },
              { label: t("goals:snapshot.metric_draw"), value: snap.netWithdrawalFromPortfolio },
            ];

            return (
              <div
                key={snap.age}
                className={`border-border border-b border-l-2 px-3 py-2.5 last:border-b-0 ${rowClassName}`}
              >
                <div className="grid grid-cols-[2.25rem_minmax(0,1fr)_auto] items-center gap-2">
                  <div className="text-muted-foreground text-xs font-semibold tabular-nums">
                    {snap.age}
                  </div>
                  <div className="flex min-w-0 items-center gap-1.5">
                    <span className="text-xs font-medium tabular-nums">{snap.year}</span>
                    <Badge
                      variant={isFire ? "default" : "secondary"}
                      className="h-5 shrink-0 px-2 text-[10px]"
                    >
                      {phaseText}
                    </Badge>
                  </div>
                  <div className="text-right text-sm font-semibold tabular-nums">
                    <SnapshotAmount
                      value={snap.portfolioEnd}
                      age={snap.age}
                      currency={currency}
                      scaleForModeAtAge={scaleForModeAtAge}
                      compact
                    />
                  </div>
                </div>

                <div className="mt-1.5 grid grid-cols-4 gap-2 pl-[2.75rem] text-[10px]">
                  {mobileMetrics.map((metric) => (
                    <div key={metric.label} className="min-w-0">
                      <div className="text-muted-foreground leading-3">{metric.label}</div>
                      <div className="truncate font-medium tabular-nums leading-4">
                        <SnapshotAmount
                          value={metric.value}
                          age={snap.age}
                          currency={currency}
                          scaleForModeAtAge={scaleForModeAtAge}
                          compact
                        />
                      </div>
                    </div>
                  ))}
                  {hasPensionFunds && (
                    <div className="col-span-4 min-w-0">
                      <span className="text-muted-foreground mr-1">{t("goals:snapshot.fund")}</span>
                      <span className="font-medium tabular-nums">
                        <SnapshotAmount
                          value={snap.pensionAssets}
                          age={snap.age}
                          currency={currency}
                          scaleForModeAtAge={scaleForModeAtAge}
                          compact
                        />
                      </span>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        <div className="hidden overflow-x-auto md:block">
          <table className="w-full min-w-[860px] text-xs">
            <thead>
              <tr className="text-muted-foreground border-b">
                <th className="pb-2 text-left">{t("goals:snapshot.col_age")}</th>
                <th className="pb-2 text-left">{t("goals:snapshot.col_year")}</th>
                <th className="pb-2 text-left">{t("goals:snapshot.col_phase")}</th>
                <th className="pb-2 text-right">{t("goals:snapshot.col_end_portfolio")}</th>
                {hasPensionFunds && (
                  <th className="pb-2 text-right">{t("goals:snapshot.col_pension_fund")}</th>
                )}
                <th className="pb-2 text-right">{t("goals:snapshot.col_contribution_yr")}</th>
                <th className="pb-2 text-right">{t("goals:snapshot.col_retirement_income_yr")}</th>
                <th className="pb-2 text-right">{t("goals:snapshot.col_planned_spending_yr")}</th>
                <th className="pb-2 text-right">
                  {t("goals:snapshot.col_portfolio_withdrawal_yr")}
                </th>
              </tr>
            </thead>
            <tbody>
              {pagedSnapshots.map((snap) => {
                const isFire = snap.phase === "fire";
                const isFireRow = snap.age === fiAge;
                const isIncomeRow = incomeStartAges.has(snap.age);
                return (
                  <tr
                    key={snap.age}
                    className={`border-b last:border-0 ${
                      isFireRow
                        ? "bg-green-50 font-semibold dark:bg-green-950/20"
                        : isIncomeRow
                          ? "bg-blue-50 dark:bg-blue-950/20"
                          : ""
                    }`}
                  >
                    <td className="py-1.5">{snap.age}</td>
                    <td className="py-1.5">{snap.year}</td>
                    <td className="py-1.5">
                      <Badge variant={isFire ? "default" : "secondary"} className="text-xs">
                        {isFire ? phaseLabel : t("goals:snapshot.phase_acc")}
                      </Badge>
                    </td>
                    <td className="py-1.5 text-right">
                      {formatAmount(scaleForModeAtAge(snap.portfolioEnd, snap.age), currency)}
                    </td>
                    {hasPensionFunds && (
                      <td className="py-1.5 text-right">
                        <SnapshotAmount
                          value={snap.pensionAssets}
                          age={snap.age}
                          currency={currency}
                          scaleForModeAtAge={scaleForModeAtAge}
                        />
                      </td>
                    )}
                    <td className="py-1.5 text-right">
                      <SnapshotAmount
                        value={snap.annualContribution}
                        age={snap.age}
                        currency={currency}
                        scaleForModeAtAge={scaleForModeAtAge}
                      />
                    </td>
                    <td className="py-1.5 text-right">
                      <SnapshotAmount
                        value={snap.annualIncome}
                        age={snap.age}
                        currency={currency}
                        scaleForModeAtAge={scaleForModeAtAge}
                      />
                    </td>
                    <td className="py-1.5 text-right">
                      <SnapshotAmount
                        value={snap.plannedExpenses ?? snap.annualExpenses}
                        age={snap.age}
                        currency={currency}
                        scaleForModeAtAge={scaleForModeAtAge}
                      />
                    </td>
                    <td className="py-1.5 text-right">
                      <SnapshotAmount
                        value={snap.netWithdrawalFromPortfolio}
                        age={snap.age}
                        currency={currency}
                        scaleForModeAtAge={scaleForModeAtAge}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}
