import { usePersistentState } from "@/hooks/use-persistent-state";

const STORAGE_KEY = "spending-savings-in-cash-flow";

/**
 * Whether money moved to and from savings counts in the cash flow views: the
 * net figure, the "Where it went" breakdown and the money flow chart.
 *
 * On by default, which is how those views have always read. Off suits a period
 * where a transfer of existing cash into a brokerage dwarfs the income and
 * spending around it: the views then show income against spending alone, and
 * "Net saved" stays as a figure of its own.
 *
 * One preference for the dashboard and the insights page, kept on this device.
 */
export function useSavingsInCashFlow() {
  return usePersistentState<boolean>(STORAGE_KEY, true);
}

/** What is left of the income: after spending, and after net saving when it counts. */
export function netCashFlow(
  totals: { income: number; spending: number; saved: number; fromSavings: number },
  includeSavings: boolean,
): number {
  const beforeSavings = totals.income - totals.spending;
  return includeSavings ? beforeSavings - totals.saved + totals.fromSavings : beforeSavings;
}
