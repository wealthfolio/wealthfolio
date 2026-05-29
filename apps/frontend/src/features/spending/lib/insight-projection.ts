/**
 * Project a SpendingInsight payload into MonthlyReport + BudgetSnapshot
 * shapes consumed by the WhereIAmStage children (PaceCard, SpentThisPeriodCard,
 * NetCashflowCard, BreakdownCanvas + CategoryHierarchyTable).
 *
 * Why: the older components stitched two server payloads together client-side
 * (budget rows × range.months + a separate spending report), which is the
 * source of the math drift bugs. This adapter funnels every number through the
 * single insight payload — same field names, reconciled magnitudes.
 *
 * Note: BudgetSnapshot.computed.totals.spendingPlanned is now a PERIOD-level
 * budget (already buffered, already prorated). Callers that previously
 * multiplied by `range.months` must drop that multiplier. The pace card has
 * been updated accordingly.
 */

import type { BudgetCategoryRow, BudgetGroupRow, BudgetSnapshot } from "../types/budget";
import type { SpendingInsight } from "../types/insight";
import type { CategoryBreakdownRow, MonthBucket, MonthlyReport } from "../types/report";

const SPENDING_TAXONOMY = "spending_categories";

/** Synthetic category id used to surface uncategorized spend as a breakdown row. */
export const UNCATEGORIZED_CATEGORY_ID = "__uncategorized__";

export interface InsightReportProjection {
  currentReport: MonthlyReport;
  priorReport: MonthlyReport;
  budget: BudgetSnapshot;
  months: MonthBucket[];
}

export function insightToReportProjection(insight: SpendingInsight): InsightReportProjection {
  const currentSpendingBreakdown = projectSpendingBreakdown(insight, "current");
  const priorSpendingBreakdown = projectSpendingBreakdown(insight, "prior");
  const dayCategoryBuckets = insight.byDayByCategory ?? [];

  const currentReport: MonthlyReport = {
    current: {
      income: insight.headline.income,
      outflow: insight.headline.spent,
      net: insight.headline.netCashflow,
      count: 0,
    },
    prior: {
      income: 0,
      outflow: insight.headline.priorSpent,
      net: -insight.headline.priorSpent,
      count: 0,
    },
    spendingBreakdown: currentSpendingBreakdown,
    incomeBreakdown: [],
    byDay: insight.byDay.map((b) => ({
      date: b.date,
      income: b.income,
      outflow: b.spent,
    })),
    byDayByCategory: dayCategoryBuckets.map((b) => ({
      date: b.date,
      taxonomyId: b.taxonomyId,
      categoryId: b.categoryId,
      amount: b.amount,
      count: b.count,
    })),
  };

  // Convention: `priorReport.current` is the prior window's totals/breakdown
  // viewed AS IF it were the current window — this matches what the report
  // SpentThisPeriodCard / WhatChangedStage callers expect when they pass
  // `priorReport={priorReport}` and then read `priorReport.current.outflow`.
  // `priorReport.prior` is intentionally zero; no consumer reads it today,
  // and the insight payload only carries one level of comparison.
  const priorReport: MonthlyReport = {
    ...currentReport,
    current: {
      income: 0,
      outflow: insight.headline.priorSpent,
      net: -insight.headline.priorSpent,
      count: 0,
    },
    prior: {
      income: 0,
      outflow: 0,
      net: 0,
      count: 0,
    },
    spendingBreakdown: priorSpendingBreakdown,
  };

  const budget = projectBudget(insight);
  const months = projectMonths(insight);

  return { currentReport, priorReport, budget, months };
}

function projectSpendingBreakdown(
  insight: SpendingInsight,
  side: "current" | "prior",
): CategoryBreakdownRow[] {
  const rows: CategoryBreakdownRow[] = [];
  for (const g of insight.groups) {
    for (const c of g.categories) {
      const amount = side === "current" ? c.spent : c.priorSpent;
      if (amount === 0) continue;
      rows.push({
        taxonomyId: c.taxonomyId,
        categoryId: c.categoryId,
        amount,
        count: side === "current" ? c.txnCount : 0,
      });
    }
  }
  if (side === "current" && insight.uncategorized.spent !== 0) {
    rows.push({
      taxonomyId: SPENDING_TAXONOMY,
      categoryId: UNCATEGORIZED_CATEGORY_ID,
      amount: insight.uncategorized.spent,
      count: insight.uncategorized.txnCount,
    });
  } else if (side === "prior" && insight.uncategorized.priorSpent !== 0) {
    rows.push({
      taxonomyId: SPENDING_TAXONOMY,
      categoryId: UNCATEGORIZED_CATEGORY_ID,
      amount: insight.uncategorized.priorSpent,
      count: 0,
    });
  }
  return rows;
}

function projectBudget(insight: SpendingInsight): BudgetSnapshot {
  const groupRows: BudgetGroupRow[] = insight.groups.map((g) => {
    const categories: BudgetCategoryRow[] = g.categories.map((c) => {
      const hasOverride = c.budget.monthlyBreakdown.some(
        (m) => m.source === "override" || m.source === "prorated_override",
      );
      return {
        taxonomyId: c.taxonomyId,
        categoryId: c.categoryId,
        groupId: g.group.id,
        parentId: c.parentId,
        name: c.name,
        color: c.color,
        icon: c.icon,
        target: c.budget.total,
        actual: c.spent,
        rolloverIn: 0,
        rolloverOut: 0,
        remaining: c.remaining,
        overspent: c.overspent,
        hasDefaultTarget: c.budget.total > 0,
        hasMonthOverride: hasOverride,
        rolloverEnabled: false,
      };
    });
    return {
      group: g.group,
      categoryTargetTotal: g.budget.total,
      buffer: g.buffer.total,
      plannedTotal: g.budget.total + g.buffer.total,
      actual: g.spent,
      rolloverIn: 0,
      rolloverOut: 0,
      remaining: g.remaining,
      overspent: g.overspent,
      rolloverEnabled: false,
      categories,
    };
  });

  return {
    state: {
      groups: insight.groups.map((g) => g.group),
      groupAssignments: [],
      targets: [],
      rolloverSettings: [],
    },
    computed: {
      currency: insight.currency,
      periodKey: "default",
      fxAsOf: null,
      groupRows,
      ungroupedRows: [],
      incomeRows: [],
      totals: {
        spendingPlanned: insight.headline.budget,
        spendingActual: insight.headline.spent,
        spendingRemaining: insight.headline.remaining,
        incomePlanned: 0,
        incomeActual: insight.headline.income,
        groupBuffer: insight.groups.reduce((sum, g) => sum + g.buffer.total, 0),
        rolloverIn: 0,
        rolloverOut: 0,
        overspentCount: insight.groups.reduce(
          (sum, g) => sum + (g.overspent ? 1 : 0) + g.categories.filter((c) => c.overspent).length,
          0,
        ),
      },
    },
  };
}

function projectMonths(insight: SpendingInsight): MonthBucket[] {
  const dayCategoryBuckets = insight.byDayByCategory ?? [];
  const breakdownByMonth = new Map<string, Map<string, CategoryBreakdownRow>>();
  for (const b of dayCategoryBuckets) {
    const month = b.date.slice(0, 7);
    const key = `${b.taxonomyId}\u0000${b.categoryId}`;
    const rows = breakdownByMonth.get(month) ?? new Map<string, CategoryBreakdownRow>();
    const row = rows.get(key) ?? {
      taxonomyId: b.taxonomyId,
      categoryId: b.categoryId,
      amount: 0,
      count: 0,
    };
    row.amount += b.amount;
    row.count += b.count;
    rows.set(key, row);
    breakdownByMonth.set(month, rows);
  }

  return insight.byMonth.map((m) => ({
    iso: `${m.month}-01`,
    label: monthShortLabel(m.month),
    report: {
      current: {
        income: m.income,
        outflow: m.spent,
        net: m.income - m.spent,
        count: 0,
      },
      prior: { income: 0, outflow: 0, net: 0, count: 0 },
      spendingBreakdown: Array.from(breakdownByMonth.get(m.month)?.values() ?? []),
      incomeBreakdown: [],
      byDay: [],
      byDayByCategory: [],
    },
    isLoading: false,
  }));
}

function monthShortLabel(monthKey: string): string {
  const [yearStr, monthStr] = monthKey.split("-");
  const year = Number(yearStr);
  const month = Number(monthStr) - 1;
  if (Number.isNaN(year) || Number.isNaN(month)) return monthKey;
  return new Date(year, month, 1).toLocaleString(undefined, { month: "short" });
}
