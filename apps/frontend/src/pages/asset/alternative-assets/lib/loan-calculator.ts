/** Reads stored loan terms back for display; the backend derives everything saved. */
import { addDays, addMonths, differenceInCalendarDays, differenceInCalendarMonths } from "date-fns";
import type { LoanPaymentFrequency } from "./loan-events";

export const LOAN_PERIODS_PER_YEAR: Record<LoanPaymentFrequency, number> = {
  monthly: 12,
  biweekly: 26,
  accelerated_biweekly: 26,
};

export function getLoanPeriodsPerYear(frequency: LoanPaymentFrequency = "monthly"): number {
  return LOAN_PERIODS_PER_YEAR[frequency];
}

/** Contractual payments due from the first payment through a date, inclusive. */
export function countLoanPayments(
  firstPaymentDate: Date,
  throughDate: Date,
  frequency: LoanPaymentFrequency = "monthly",
): number {
  if (throughDate < firstPaymentDate) return 0;
  if (frequency !== "monthly")
    return Math.floor(differenceInCalendarDays(throughDate, firstPaymentDate) / 14) + 1;
  const count = differenceInCalendarMonths(throughDate, firstPaymentDate) + 1;
  const last = calculateLoanPaymentDate(firstPaymentDate, count - 1, frequency);
  // Calendar days: where DST starts at midnight, a date can begin at 01:00.
  return last && differenceInCalendarDays(last, throughDate) > 0 ? count - 1 : count;
}

/** Whole months of amortization between the first and last contractual payments. */
export function calculateAmortizationMonths(
  firstPaymentDate: Date,
  lastPaymentDate: Date,
  frequency: LoanPaymentFrequency = "monthly",
): number | null {
  const paymentCount = countLoanPayments(firstPaymentDate, lastPaymentDate, frequency);
  return paymentCount > 0
    ? Math.round((paymentCount * 12) / getLoanPeriodsPerYear(frequency))
    : null;
}

/** Return a contractual payment date using a zero-based payment index. */
export function calculateLoanPaymentDate(
  firstPaymentDate: Date,
  paymentIndex: number,
  frequency: LoanPaymentFrequency = "monthly",
): Date | null {
  if (!(firstPaymentDate instanceof Date) || Number.isNaN(firstPaymentDate.getTime())) return null;
  if (!Number.isInteger(paymentIndex) || paymentIndex < 0) return null;

  if (frequency !== "monthly") return addDays(firstPaymentDate, paymentIndex * 14);
  // Keep the first payment's day, clamped in shorter months, as the shared engine does.
  return addMonths(firstPaymentDate, paymentIndex);
}
