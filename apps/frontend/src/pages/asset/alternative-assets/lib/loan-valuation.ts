import type { Quote } from "@/lib/types";
import { getLatestCurrentLoanBalance } from "./loan-balance";

export interface LoanValuationSnapshot {
  currentBalance: number;
  originalAmount: number | null;
  principalPaid: number | null;
  principalProgress: number | null;
}

/** Single valuation source shared by liability screens and linked-asset views. */
export function getLoanValuationSnapshot(
  marketValue: string | number,
  metadata: Record<string, unknown> | null | undefined,
  quotes: Quote[],
): LoanValuationSnapshot {
  const latest = getLatestCurrentLoanBalance(quotes);
  const currentBalance = Math.abs(Number(latest?.close ?? marketValue) || 0);
  const originalRaw = metadata?.original_amount ?? metadata?.purchase_price;
  const parsedOriginal = Number(originalRaw);
  const originalAmount =
    Number.isFinite(parsedOriginal) && parsedOriginal > 0 ? parsedOriginal : null;
  const principalPaid =
    originalAmount === null ? null : Math.max(0, originalAmount - currentBalance);
  const principalProgress =
    originalAmount === null ? null : Math.min(1, principalPaid! / originalAmount);
  return { currentBalance, originalAmount, principalPaid, principalProgress };
}
