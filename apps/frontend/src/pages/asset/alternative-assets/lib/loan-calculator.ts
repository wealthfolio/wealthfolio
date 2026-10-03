import { addDays, addMonths, differenceInCalendarDays, differenceInCalendarMonths } from "date-fns";
import type { LoanInterestMethod, LoanPaymentFrequency } from "./loan-events";

export const LOAN_PERIODS_PER_YEAR: Record<LoanPaymentFrequency, number> = {
  monthly: 12,
  biweekly: 26,
  accelerated_biweekly: 26,
};

export interface LoanProjectionInput {
  principal: number;
  annualRate: number;
  paymentCount: number;
  paymentAmount?: number;
  frequency?: LoanPaymentFrequency;
  interestMethod?: LoanInterestMethod;
}

export function getLoanPeriodsPerYear(frequency: LoanPaymentFrequency = "monthly"): number {
  return LOAN_PERIODS_PER_YEAR[frequency];
}

/** Payment preview only; authoritative dated balances come from the Rust engine. */
export function loanPeriodicRate(
  annualRate: number,
  frequency: LoanPaymentFrequency = "monthly",
  method: LoanInterestMethod = "nominal_periodic",
): number {
  const periods = getLoanPeriodsPerYear(frequency);
  if (method === "nominal_periodic") return annualRate / 100 / periods;
  const compounds = method === "monthly" ? 12 : 2;
  return Math.expm1((Math.log1p(annualRate / 100 / compounds) * compounds) / periods);
}

export function calculatePaymentCount(
  termYears: number,
  frequency: LoanPaymentFrequency = "monthly",
): number | null {
  if (!Number.isFinite(termYears) || termYears <= 0) return null;
  const count = Math.round(termYears * getLoanPeriodsPerYear(frequency));
  return count > 0 ? count : null;
}

function validInput({ principal, annualRate, paymentCount }: LoanProjectionInput): boolean {
  return (
    Number.isFinite(principal) &&
    principal >= 0 &&
    principal <= 1e15 &&
    Number.isFinite(annualRate) &&
    annualRate >= 0 &&
    annualRate <= 100 &&
    Number.isInteger(paymentCount) &&
    paymentCount > 0 &&
    paymentCount <= 2600
  );
}

/** Calculate a constant-payment amount without any UI or persistence concerns. */
export function calculateLoanPayment({
  principal,
  annualRate,
  paymentCount,
  frequency,
  interestMethod,
}: LoanProjectionInput): number | null {
  if (!validInput({ principal, annualRate, paymentCount })) return null;
  if (principal === 0) return 0;

  const accelerated = frequency === "accelerated_biweekly";
  const count = accelerated ? (paymentCount * 12) / 26 : paymentCount;
  const divisor = accelerated ? 2 : 1;
  const periodicRate = loanPeriodicRate(
    annualRate,
    accelerated ? "monthly" : frequency,
    interestMethod,
  );
  return periodicRate === 0
    ? principal / count / divisor
    : (principal * periodicRate) / -Math.expm1(-count * Math.log1p(periodicRate)) / divisor;
}

/** Calculate the contractual date of the last payment. */
export function calculateLoanEndDate(
  firstPaymentDate: Date,
  paymentCount: number,
  frequency: LoanPaymentFrequency = "monthly",
): Date | null {
  if (!(firstPaymentDate instanceof Date) || Number.isNaN(firstPaymentDate.getTime())) return null;
  if (!Number.isInteger(paymentCount) || paymentCount <= 0) return null;

  return calculateLoanPaymentDate(firstPaymentDate, paymentCount - 1, frequency);
}

/** Payments and last payment date of an amortization period given in months. */
export function calculateAmortizationSchedule(
  firstPaymentDate: Date | null | undefined,
  months: number,
  frequency: LoanPaymentFrequency = "monthly",
): { paymentCount: number; lastPaymentDate: Date } | null {
  if (!firstPaymentDate) return null;
  const paymentCount = calculatePaymentCount(months / 12, frequency);
  const lastPaymentDate =
    paymentCount && calculateLoanEndDate(firstPaymentDate, paymentCount, frequency);
  return paymentCount && lastPaymentDate ? { paymentCount, lastPaymentDate } : null;
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
  return last && last > throughDate ? count - 1 : count;
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
