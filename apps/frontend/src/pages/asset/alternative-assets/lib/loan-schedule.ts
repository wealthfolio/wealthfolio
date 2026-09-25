import { endOfMonth, format, isAfter, isLastDayOfMonth } from "date-fns";
import type { Quote } from "@/lib/types";
import type { QuoteImport } from "@/lib/types/quote-import";
import { isProjectedLoanBalance } from "./loan-balance";
import {
  calculateLoanPayment,
  calculateLoanPaymentDate,
  calculatePaymentCountThroughDate,
  projectLoan,
} from "./loan-calculator";
import type { LoanPaymentFrequency } from "./loan-events";

interface BuildLoanScheduleParams {
  assetId: string;
  currency: string;
  startingBalance: number;
  annualRate: number;
  paymentCount: number;
  firstPaymentDate: Date;
  monthlyPayment?: number;
  frequency?: LoanPaymentFrequency;
}

export interface RemainingScheduleWindow {
  firstPaymentDate: Date;
  paymentCount: number;
}

/** Find contractual payment dates strictly after a known balance date. */
export function getRemainingScheduleWindow(
  originationDate: Date,
  effectiveBalanceDate: Date,
  endDate: Date,
  frequency: LoanPaymentFrequency = "monthly",
): RemainingScheduleWindow | null {
  if (isAfter(originationDate, effectiveBalanceDate) || isAfter(effectiveBalanceDate, endDate)) {
    return null;
  }

  const totalPaymentCount = calculatePaymentCountThroughDate(originationDate, endDate, frequency);
  const completedPaymentCount = calculatePaymentCountThroughDate(
    originationDate,
    effectiveBalanceDate,
    frequency,
  );
  if (totalPaymentCount <= completedPaymentCount) return null;

  const firstPaymentDate = calculateLoanPaymentDate(
    originationDate,
    completedPaymentCount,
    frequency,
  );
  if (!firstPaymentDate) return null;

  return {
    firstPaymentDate,
    paymentCount: totalPaymentCount - completedPaymentCount,
  };
}

export function calculateMonthlyPayment(
  principal: number,
  annualRate: number,
  paymentCount: number,
  frequency: LoanPaymentFrequency = "monthly",
): number | null {
  return calculateLoanPayment({ principal, annualRate, paymentCount, frequency });
}

export function calculateRemainingPaymentCount(
  balance: number,
  annualRate: number,
  monthlyPayment: number,
  frequency: LoanPaymentFrequency = "monthly",
): number | null {
  if (balance === 0) return 0;
  if (balance < 0 || annualRate < 0 || monthlyPayment <= 0) return null;
  if (![balance, annualRate, monthlyPayment].every(Number.isFinite)) return null;

  const periodicRate = annualRate / 100 / (frequency === "monthly" ? 12 : 26);
  if (periodicRate === 0) return Math.ceil(balance / monthlyPayment);
  if (monthlyPayment <= balance * periodicRate) return null;

  const exactCount =
    -Math.log(1 - (balance * periodicRate) / monthlyPayment) / Math.log(1 + periodicRate);
  return Number.isFinite(exactCount) && exactCount > 0 ? Math.ceil(exactCount) : null;
}

export function calculateBalanceAfterPayments(
  principal: number,
  annualRate: number,
  totalPaymentCount: number,
  completedPaymentCount: number,
  frequency: LoanPaymentFrequency = "monthly",
): number | null {
  const payment = calculateMonthlyPayment(principal, annualRate, totalPaymentCount, frequency);
  if (payment === null) return null;
  if (!Number.isInteger(completedPaymentCount) || completedPaymentCount < 0) return null;
  if (completedPaymentCount === 0) return principal;
  if (completedPaymentCount >= totalPaymentCount) return 0;

  const projection = projectLoan({
    principal,
    annualRate,
    paymentCount: totalPaymentCount,
    paymentAmount: payment,
    frequency,
  });
  return projection[completedPaymentCount - 1]?.closingBalance ?? 0;
}

/** Keep an explicitly entered balance; otherwise derive it from the contractual schedule. */
export function resolveLoanBalanceAtDate(
  enteredBalance: number | undefined,
  principal: number,
  annualRate: number,
  totalPaymentCount: number,
  completedPaymentCount: number,
  frequency: LoanPaymentFrequency = "monthly",
): number | null {
  if (enteredBalance !== undefined) {
    return Number.isFinite(enteredBalance) && enteredBalance >= 0 ? enteredBalance : null;
  }
  return calculateBalanceAfterPayments(
    principal,
    annualRate,
    totalPaymentCount,
    completedPaymentCount,
    frequency,
  );
}

export function buildLoanSchedule({
  assetId,
  currency,
  startingBalance,
  annualRate,
  paymentCount,
  firstPaymentDate,
  monthlyPayment,
  frequency = "monthly",
}: BuildLoanScheduleParams): QuoteImport[] {
  if (startingBalance < 0 || annualRate < 0 || paymentCount <= 0) return [];

  const projection = projectLoan({
    principal: startingBalance,
    annualRate,
    paymentCount,
    paymentAmount: monthlyPayment,
    frequency,
  });
  if (projection.length === 0) return [];
  const preserveEndOfMonth = isLastDayOfMonth(firstPaymentDate);

  return projection.map((row, index) => {
    const nominalDate = calculateLoanPaymentDate(firstPaymentDate, index, frequency)!;
    const paymentDate =
      preserveEndOfMonth && frequency === "monthly" ? endOfMonth(nominalDate) : nominalDate;
    return {
      symbol: assetId,
      date: format(paymentDate, "yyyy-MM-dd"),
      close: row.closingBalance,
      currency,
      notes: `loan_schedule|rate=${annualRate}|payment=${row.payment}`,
      validationStatus: "valid" as const,
    };
  });
}

export function splitLoanScheduleForPersistence(schedule: QuoteImport[]): {
  importableQuotes: QuoteImport[];
  payoffQuote: QuoteImport | null;
} {
  return {
    importableQuotes: schedule.filter((quote) => quote.close > 0),
    payoffQuote: [...schedule].reverse().find((quote) => quote.close === 0) ?? null,
  };
}

/**
 * Return only obsolete generated future quotes. User-entered values are never
 * removed when a loan schedule is recalculated.
 */
export function getObsoleteFutureQuoteIds(
  existingQuotes: Quote[],
  effectiveDate: Date,
  replacementSchedule: QuoteImport[],
): string[] {
  const effectiveDay = format(effectiveDate, "yyyy-MM-dd");
  const replacementDays = new Set(replacementSchedule.map((quote) => quote.date));

  return existingQuotes
    .filter((quote) => {
      const quoteDay = quote.timestamp.slice(0, 10);
      return (
        isProjectedLoanBalance(quote) && quoteDay > effectiveDay && !replacementDays.has(quoteDay)
      );
    })
    .map((quote) => quote.id);
}
