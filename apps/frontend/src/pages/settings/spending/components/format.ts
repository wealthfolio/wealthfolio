import type { FormattingApi } from "@wealthfolio/ui";

/**
 * Whole-currency formatter used by spending-settings cards.
 * The shared `formatAmount` always renders cents; the design calls for clean
 * round figures (CA$17,554 instead of CA$17,554.00).
 */
export function formatAmountWhole(
  amount: number | string | null | undefined,
  currency: string,
  formatting: Pick<FormattingApi, "formatRoundedAmount">,
): string {
  if (amount == null) return "—";
  const num = typeof amount === "string" ? Number(amount) : amount;
  if (!Number.isFinite(num)) return "—";
  return formatting.formatRoundedAmount(Math.abs(num) < 0.5 ? 0 : num, currency);
}
