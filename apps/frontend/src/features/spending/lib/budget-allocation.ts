import type { BudgetGroupRow, BudgetTotals } from "../types/budget";

/**
 * What the plan sets aside, to compare with income: spending budgets (a
 * limit) and savings goals together. Compare spending with
 * `spendingPlanned` alone.
 */
export function totalAllocation(totals: BudgetTotals): number {
  return totals.spendingPlanned + totals.savingsPlanned;
}

/** A group's share of the plan: its spending budget and savings goals. */
export function groupAllocation(row: BudgetGroupRow): number {
  return row.plannedTotal + row.savingsTargetTotal;
}
