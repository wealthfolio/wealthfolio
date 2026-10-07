import { describe, expect, it } from "vitest";
import type { LoanCalculation, LoanCalculationRow } from "@/adapters/shared/alternative-assets";
import type { Quote } from "@/lib/types";
import {
  confirmedLoanBalances,
  loanBalanceTimeline,
  loanDisplayBalance,
  loanMarkers,
  loanMilestones,
  loanPeriod,
} from "./loan-presentation";
const row = (date: string, balance: number): LoanCalculationRow => ({
  date,
  balance,
  openingBalance: balance + 100,
  payment: 100,
  principal: 100,
  interest: 0,
  confirmed: false,
  balanceAdjustment: 0,
  extraPayment: 0,
  scheduledPayment: true,
});
const calculation: LoanCalculation = {
  interestMethod: "nominal_periodic",
  calculationStartDate: "2025-01-01",
  currentBalance: 700,
  annualRate: 0,
  paymentAmount: 100,
  frequency: "monthly",
  remainingPayments: 7,
  interestToDate: 0,
  projectedInterest: 0,
  residualBalance: 0,
  residualInterest: 0,
  payoffDate: "2026-10-01",
  allocations: [],
  instalments: [],
  paymentSuggestion: null,
  rows: [
    row("2025-12-31", 1000),
    row("2026-01-01", 900),
    row("2026-02-01", 800),
    row("2026-03-01", 700),
    row("2026-10-01", 0),
  ],
};
const quote = (date: string, close: number, notes?: string) =>
  ({ timestamp: `${date}T00:00:00Z`, close, notes }) as Quote;
describe("loan overview presentation", () => {
  it("includes payments on the first day and uses the as-of closing balance for YTD", () => {
    const points = loanBalanceTimeline(calculation, [quote("2026-02-01", 800)], "2026-03-15");
    const period = loanPeriod(points, "2026-01-01", "2026-03-15");
    expect(period.reduction).toBe(300);
    expect(period.percent).toBe(0.3);
    expect(period.points.at(-1)).toEqual({ date: "2026-03-15", balance: 700 });
    expect(period.points.every((point) => point.date <= "2026-03-15")).toBe(true);
  });
  it("changes the reduction with the chosen period, independently of confirmations", () => {
    const points = loanBalanceTimeline(calculation, [], "2026-03-15");
    expect(loanPeriod(points, "2026-02-15", "2026-03-15").reduction).toBe(100);
  });
  it("does not call one in-period confirmation zero change when opening balance is unknown", () => {
    const points = loanBalanceTimeline(null, [quote("2026-03-01", 700)], "2026-03-15");
    expect(loanPeriod(points, "2026-01-01", "2026-03-15").reduction).toBeNull();
  });
  it("carries sparse manual balances across a period boundary", () => {
    const points = loanBalanceTimeline(
      null,
      [quote("2025-12-01", 1000), quote("2026-03-01", 700)],
      "2026-03-15",
    );
    expect(loanPeriod(points, "2026-01-01", "2026-03-15").reduction).toBe(300);
  });
  it("leads a manual loan with its latest recorded balance, extra repayments included", () => {
    expect(loanDisplayBalance(null, "-800")).toBe(800);
    expect(loanDisplayBalance(calculation, "-800")).toBe(calculation.currentBalance);
  });
  it("excludes future quotes from confirmed balances", () => {
    expect(
      confirmedLoanBalances([quote("2026-03-01", 700), quote("2027-01-01", 0)], "2026-03-15"),
    ).toHaveLength(1);
  });
  it("does not show expired renewal as the default forecast and distinguishes payoff from the contract", () => {
    expect(
      loanMilestones(
        calculation,
        {
          renewal_maturity_date: "2026-02-01",
          loan_projection: {
            version: 1,
            annualRate: 0,
            paymentAmount: 100,
            frequency: "monthly",
            firstPaymentDate: "2026-02-01",
            amortizationEndDate: "2027-10-01",
          },
        },
        "2026-03-15",
      ),
    ).toMatchObject({ upcomingRenewal: false, payoff: "2026-10-01", monthsEarly: 12 });
    expect(
      loanMilestones({ ...calculation, residualBalance: 5 }, {}, "2026-03-15").payoff,
    ).toBeUndefined();
    expect(loanMilestones(null, {}, "2026-03-15").payoff).toBeUndefined();
  });
  it("combines dated events with confirmed correction markers", () => {
    const markers = loanMarkers(
      {
        loan_events: [
          { type: "renewal", effectiveDate: "2026-02-01", annualRate: 4 },
          { type: "extra_repayment", effectiveDate: "2026-03-01", amount: 100 },
        ],
      },
      [quote("2026-03-02", 700, "loan_event|type=balance_correction")],
      "2026-03-15",
    );
    expect(markers.find((event) => event.type === "extra_repayment")?.amount).toBe(100);
    expect(markers.find((event) => event.type === "renewal")).toMatchObject({ annualRate: 4 });
    expect(markers.map((event) => event.type)).toEqual([
      "renewal",
      "extra_repayment",
      "balance_correction",
    ]);
  });
});

it("ignores events after settlement and does not claim payoff with unpaid interest", () => {
  const trailing = {
    ...row("2027-01-01", 0),
    openingBalance: 0,
    payment: 0,
    principal: 0,
    interest: 0,
  };
  const withTrailing = { ...calculation, rows: [...calculation.rows, trailing] };
  expect(loanMilestones(withTrailing, {}, "2026-03-15").payoff).toBe("2026-10-01");
  expect(
    loanMilestones({ ...withTrailing, residualInterest: 5.81 }, {}, "2026-03-15").payoff,
  ).toBeUndefined();
});
