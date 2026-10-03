import { intervalToDuration, isValid, parseISO } from "date-fns";
import type { LoanCalculation } from "@/adapters/shared/alternative-assets";
import { loanPayoffDate } from "./loan-presentation";

/** Summarize the authoritative schedule; never calculate a second loan projection. */
export function getLoanRenewalSummary(
  calculation: LoanCalculation,
  maturity: string,
  today: string,
) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(maturity) || !isValid(parseISO(maturity)) || maturity < today)
    return null;
  const rows = calculation.rows;
  const last = rows.at(-1);
  // An unpaid balance beyond the projection horizon has no reliable forecast.
  if (
    !last ||
    (maturity > last.date && (calculation.residualBalance > 0 || calculation.residualInterest > 0))
  )
    return null;
  const balance =
    rows.filter((row) => row.date <= maturity).at(-1)?.balance ?? calculation.currentBalance;
  const termPayments = rows.filter(
    (row) => row.date > today && row.date <= maturity && row.scheduledPayment,
  );
  const payoff = loanPayoffDate(calculation);
  const remaining = payoff
    ? intervalToDuration({
        start: parseISO(maturity),
        end: parseISO(payoff > maturity ? payoff : maturity),
      })
    : null;
  return {
    balance,
    payments: termPayments.length,
    principal: termPayments.reduce((sum, row) => sum + row.principal, 0),
    interest: termPayments.reduce((sum, row) => sum + row.interest, 0),
    years: remaining ? (remaining.years ?? 0) : null,
    months: remaining ? (remaining.months ?? 0) : null,
  };
}
