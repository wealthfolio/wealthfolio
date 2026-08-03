/**
 * Amortization helpers for liability (loan) assets.
 *
 * Assumes a standard fixed-rate loan repaid via equal monthly installments
 * (the common "prêt amortissable à mensualités constantes" shape used for
 * mortgages, auto loans, and personal loans).
 */

export interface LoanAmortizationInput {
  /** Original principal borrowed. */
  principal: number;
  /** Nominal annual interest rate, as a percentage (e.g. 3.5 for 3.5%). */
  annualRatePercent: number;
  startDate: Date;
  endDate: Date;
}

export interface LoanAmortizationResult {
  /** Whole number of months between start and end date. */
  months: number;
  monthlyPayment: number;
  totalPaid: number;
  /** Total interest paid over the life of the loan ("coût total du crédit"). */
  totalInterestCost: number;
}

/**
 * Returns null when the inputs can't produce a meaningful amortization
 * (missing/non-positive principal, or end date not after start date).
 */
export function calculateLoanAmortization({
  principal,
  annualRatePercent,
  startDate,
  endDate,
}: LoanAmortizationInput): LoanAmortizationResult | null {
  if (!(principal > 0)) return null;

  const months = monthsBetween(startDate, endDate);
  if (months <= 0) return null;

  const monthlyRate = annualRatePercent / 100 / 12;
  const monthlyPayment =
    monthlyRate > 0
      ? (principal * monthlyRate) / (1 - Math.pow(1 + monthlyRate, -months))
      : principal / months;

  const totalPaid = monthlyPayment * months;
  const totalInterestCost = totalPaid - principal;

  return { months, monthlyPayment, totalPaid, totalInterestCost };
}

function monthsBetween(start: Date, end: Date): number {
  const years = end.getFullYear() - start.getFullYear();
  const months = end.getMonth() - start.getMonth();
  const dayAdjustment = end.getDate() < start.getDate() ? -1 : 0;
  return years * 12 + months + dayAdjustment;
}
