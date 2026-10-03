import { describe, expect, it } from "vitest";
import type { LoanCalculation, LoanCalculationRow } from "@/adapters/shared/alternative-assets";
import { getLoanRenewalSummary } from "./loan-renewal-summary";
const row = (date: string, balance: number, scheduledPayment = true): LoanCalculationRow => ({
  date,
  balance,
  scheduledPayment,
  openingBalance: balance + 100,
  payment: 100,
  principal: 100,
  interest: 0,
  confirmed: false,
  balanceAdjustment: 0,
  extraPayment: 0,
});
const calculation: LoanCalculation = {
  interestMethod: "nominal_periodic",
  calculationStartDate: "2025-01-01",
  currentBalance: 500,
  annualRate: 0,
  paymentAmount: 100,
  frequency: "monthly",
  remainingPayments: 5,
  interestToDate: 0,
  projectedInterest: 0,
  residualBalance: 0,
  residualInterest: 0,
  payoffDate: "2027-04-01",
  rows: [
    row("2026-01-01", 500),
    row("2026-02-01", 400),
    row("2026-02-15", 350, false),
    row("2026-03-01", 250),
    row("2027-04-01", 0),
  ],
};
describe("renewal outlook", () => {
  it("uses closing balances, excludes today's payment and extra repayments from the count", () => {
    expect(getLoanRenewalSummary(calculation, "2026-03-01", "2026-01-01")).toEqual({
      balance: 250,
      payments: 2,
      principal: 200,
      interest: 0,
      years: 1,
      months: 1,
    });
  });
  it("uses the last balance between payment dates", () => {
    expect(getLoanRenewalSummary(calculation, "2026-02-20", "2026-01-01")?.balance).toBe(350);
  });
  it("shows zero remaining amortization after payoff", () => {
    expect(getLoanRenewalSummary(calculation, "2028-01-01", "2026-01-01")).toMatchObject({
      balance: 0,
      years: 0,
      months: 0,
    });
  });
  it("does not invent a payoff for an underpaying loan", () => {
    const unpaid = {
      ...calculation,
      residualBalance: 50,
      rows: [...calculation.rows.slice(0, -1), row("2027-04-01", 50)],
    };
    expect(getLoanRenewalSummary(unpaid, "2026-03-01", "2026-01-01")?.years).toBeNull();
    expect(getLoanRenewalSummary(unpaid, "2028-01-01", "2026-01-01")).toBeNull();
  });
  it("rejects missing, invalid and expired renewal dates", () => {
    for (const date of ["", "invalid", "2026-13-01", "2025-01-01"])
      expect(getLoanRenewalSummary(calculation, date, "2026-01-01")).toBeNull();
  });
});
