import {
  addMonths,
  differenceInCalendarMonths,
  endOfMonth,
  format,
  isAfter,
  isLastDayOfMonth,
} from "date-fns";
import type { Quote } from "@/lib/types";
import type { QuoteImport } from "@/lib/types/quote-import";

interface BuildLoanScheduleParams {
  assetId: string;
  currency: string;
  startingBalance: number;
  annualRate: number;
  paymentCount: number;
  firstPaymentDate: Date;
  monthlyPayment?: number;
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
): RemainingScheduleWindow | null {
  if (isAfter(originationDate, effectiveBalanceDate) || isAfter(effectiveBalanceDate, endDate)) {
    return null;
  }

  const completedMonths = differenceInCalendarMonths(effectiveBalanceDate, originationDate);
  let firstPaymentDate = addMonths(originationDate, completedMonths + 1);
  if (!isAfter(firstPaymentDate, effectiveBalanceDate)) {
    firstPaymentDate = addMonths(originationDate, completedMonths + 2);
  }
  if (isAfter(firstPaymentDate, endDate)) return null;

  return {
    firstPaymentDate,
    paymentCount: differenceInCalendarMonths(endDate, firstPaymentDate) + 1,
  };
}

export function calculateMonthlyPayment(
  principal: number,
  annualRate: number,
  paymentCount: number,
): number | null {
  if (!Number.isFinite(principal) || principal < 0) return null;
  if (!Number.isFinite(annualRate) || annualRate < 0) return null;
  if (!Number.isInteger(paymentCount) || paymentCount <= 0) return null;
  if (principal === 0) return 0;

  const monthlyRate = annualRate / 100 / 12;
  return monthlyRate > 0
    ? (principal * monthlyRate) / (1 - Math.pow(1 + monthlyRate, -paymentCount))
    : principal / paymentCount;
}

export function calculateRemainingPaymentCount(
  balance: number,
  annualRate: number,
  monthlyPayment: number,
): number | null {
  if (balance === 0) return 0;
  if (balance < 0 || annualRate < 0 || monthlyPayment <= 0) return null;
  if (![balance, annualRate, monthlyPayment].every(Number.isFinite)) return null;

  const monthlyRate = annualRate / 100 / 12;
  if (monthlyRate === 0) return Math.ceil(balance / monthlyPayment);
  if (monthlyPayment <= balance * monthlyRate) return null;

  const exactCount =
    -Math.log(1 - (balance * monthlyRate) / monthlyPayment) / Math.log(1 + monthlyRate);
  return Number.isFinite(exactCount) && exactCount > 0 ? Math.ceil(exactCount) : null;
}

export function calculateBalanceAfterPayments(
  principal: number,
  annualRate: number,
  totalPaymentCount: number,
  completedPaymentCount: number,
): number | null {
  const payment = calculateMonthlyPayment(principal, annualRate, totalPaymentCount);
  if (payment === null) return null;
  if (!Number.isInteger(completedPaymentCount) || completedPaymentCount < 0) return null;
  if (completedPaymentCount === 0) return principal;
  if (completedPaymentCount >= totalPaymentCount) return 0;

  const monthlyRate = annualRate / 100 / 12;
  const balance =
    monthlyRate === 0
      ? principal - payment * completedPaymentCount
      : principal * Math.pow(1 + monthlyRate, completedPaymentCount) -
        payment * ((Math.pow(1 + monthlyRate, completedPaymentCount) - 1) / monthlyRate);

  return Math.max(0, Math.round(balance * 100) / 100);
}

export function buildLoanSchedule({
  assetId,
  currency,
  startingBalance,
  annualRate,
  paymentCount,
  firstPaymentDate,
  monthlyPayment,
}: BuildLoanScheduleParams): QuoteImport[] {
  if (startingBalance < 0 || annualRate < 0 || paymentCount <= 0) return [];

  const monthlyRate = annualRate / 100 / 12;
  const payment =
    monthlyPayment ?? calculateMonthlyPayment(startingBalance, annualRate, paymentCount);
  if (payment === null || !Number.isFinite(payment) || payment <= 0) return [];
  let balance = startingBalance;
  const preserveEndOfMonth = isLastDayOfMonth(firstPaymentDate);

  return Array.from({ length: paymentCount }, (_, index) => {
    const interest = balance * monthlyRate;
    balance = Math.max(0, balance - (payment - interest));

    const nominalDate = addMonths(firstPaymentDate, index);
    const paymentDate = preserveEndOfMonth ? endOfMonth(nominalDate) : nominalDate;
    return {
      symbol: assetId,
      date: format(paymentDate, "yyyy-MM-dd"),
      close: index === paymentCount - 1 ? 0 : Math.round(balance * 100) / 100,
      currency,
      notes: "loan_schedule",
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
      const isGenerated = quote.notes === "loan_schedule" || quote.notes === "scheduled_payoff";
      return isGenerated && quoteDay > effectiveDay && !replacementDays.has(quoteDay);
    })
    .map((quote) => quote.id);
}
