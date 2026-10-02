import { isClosedLoanBalance } from "./loan-balance";
import { addDays, differenceInMonths, isValid, parseISO } from "date-fns";
import type { LoanCalculation } from "@/adapters/shared/alternative-assets";
import type { Quote } from "@/lib/types";
import { formatDateISO } from "@/lib/utils";
import { classifyLoanBalance } from "./loan-balance";
import {
  readLoanEvents,
  readLoanProjectionMetadata,
  LOAN_RENEWAL_MATURITY_METADATA_KEY,
} from "./loan-events";

export interface BalancePoint {
  date: string;
  balance: number;
}
export interface LoanMarker {
  eventIndex?: number;
  amount?: number;
  annualRate?: number;
  paymentAmount?: number;
  date: string;
  type: string;
}
export function validLoanDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && isValid(parseISO(value));
}
export function confirmedLoanBalances(quotes: Quote[], today: string) {
  return quotes
    .filter((q) => q.timestamp.slice(0, 10) <= today)
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}
export function lastLoanConfirmation(quotes: Quote[], today: string) {
  return confirmedLoanBalances(quotes, today)
    .filter((quote) => classifyLoanBalance(quote) !== "extra_repayment")
    .at(-1);
}
export function loanBalanceTimeline(
  calculation: LoanCalculation | null | undefined,
  quotes: Quote[],
  today: string,
): BalancePoint[] {
  const points = new Map<string, number>();
  for (const row of calculation?.rows ?? []) points.set(row.date, row.balance);
  for (const quote of confirmedLoanBalances(quotes, today))
    points.set(quote.timestamp.slice(0, 10), Math.abs(quote.close));
  const confirmed = confirmedLoanBalances(quotes, today).at(-1);
  if (calculation || confirmed)
    points.set(today, calculation?.currentBalance ?? Math.abs(confirmed!.close));
  return [...points]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, balance]) => ({ date, balance }));
}
export function balanceAt(points: BalancePoint[], date: string) {
  return points.filter((point) => point.date <= date).at(-1)?.balance ?? null;
}
/** Opening balance precedes the selected first day; observations within it are included. */
export function loanPeriod(points: BalancePoint[], from: string | undefined, to: string) {
  const openingDate = from ? formatDateISO(addDays(parseISO(from), -1)) : points[0]?.date;
  const opening = openingDate ? balanceAt(points, openingDate) : null;
  const closing = balanceAt(points, to);
  const visible = points.filter((point) => (!from || point.date >= from) && point.date <= to);
  if (from && openingDate && opening != null)
    visible.unshift({ date: openingDate, balance: opening });
  if (closing != null && !visible.some((point) => point.date === to))
    visible.push({ date: to, balance: closing });
  return {
    points: visible,
    reduction: opening != null && closing != null ? opening - closing : null,
    percent:
      opening != null && opening > 0 && closing != null ? (opening - closing) / opening : null,
  };
}
export function loanMilestones(
  calculation: LoanCalculation | null | undefined,
  metadata: Record<string, unknown>,
  today: string,
) {
  const projection = readLoanProjectionMetadata(metadata);
  const horizon = projection?.amortizationEndDate;
  const maturity = metadata[LOAN_RENEWAL_MATURITY_METADATA_KEY];
  const payoff = loanPayoffDate(calculation);
  return {
    maturity: validLoanDate(maturity) ? maturity : undefined,
    upcomingRenewal: validLoanDate(maturity) && maturity > today,
    horizon: validLoanDate(horizon) ? horizon : undefined,
    payoff,
    monthsEarly:
      payoff && validLoanDate(horizon)
        ? Math.max(0, differenceInMonths(parseISO(horizon), parseISO(payoff)))
        : 0,
  };
}

/** Settlement includes accrued interest and is determined by the shared engine. */
export function loanPayoffDate(calculation: LoanCalculation | null | undefined) {
  if (calculation?.residualBalance !== 0 || calculation.residualInterest !== 0) return undefined;
  return calculation.payoffDate ?? undefined;
}
export function loanMarkers(
  metadata: Record<string, unknown>,
  quotes: Quote[],
  today: string,
): LoanMarker[] {
  const events: LoanMarker[] = readLoanEvents(metadata).map((event, eventIndex) => ({
    eventIndex,
    date: event.effectiveDate,
    type: event.type,
    ...(event.type === "extra_repayment" ? { amount: event.amount } : {}),
    ...(event.type === "renewal"
      ? { annualRate: event.annualRate, paymentAmount: event.paymentAmount }
      : {}),
  }));
  for (const quote of confirmedLoanBalances(quotes, today)) {
    const date = quote.timestamp.slice(0, 10);
    const type = quote.notes?.includes("type=extra_repayment")
      ? "extra_repayment"
      : isClosedLoanBalance(quote)
        ? "closed"
        : "balance_correction";
    if (!events.some((event) => event.date === date && event.type === type))
      events.push({ date, type });
  }
  return events.sort((a, b) => a.date.localeCompare(b.date));
}
