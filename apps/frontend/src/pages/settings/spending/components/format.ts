/**
 * Whole-currency formatter used by spending-settings cards.
 * The shared `formatAmount` always renders cents; the design calls for clean
 * round figures (CA$17,554 instead of CA$17,554.00).
 */
const FORMATTERS = new Map<string, Intl.NumberFormat>();

export function formatAmountWhole(
  amount: number | string | null | undefined,
  currency: string,
): string {
  if (amount == null) return "—";
  const num = typeof amount === "string" ? Number(amount) : amount;
  if (!Number.isFinite(num)) return "—";
  const cur = (currency ?? "USD").toUpperCase();
  let fmt = FORMATTERS.get(cur);
  if (!fmt) {
    try {
      fmt = new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: cur,
        maximumFractionDigits: 0,
      });
    } catch {
      // Fallback for non-ISO currency codes
      fmt = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
    }
    FORMATTERS.set(cur, fmt);
  }
  return fmt.format(Math.abs(num) < 0.5 ? 0 : num);
}
