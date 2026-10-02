import { describe, expect, it } from "vitest";
import { format } from "date-fns";
import {
  calculateAmortizationMonths,
  calculateAmortizationSchedule,
  calculateLoanEndDate,
  calculateLoanPayment,
  calculatePaymentCount,
} from "./loan-calculator";

describe("loan calculator", () => {
  it("calculates a fixed monthly payment", () => {
    expect(
      calculateLoanPayment({ principal: 100_000, annualRate: 3.6, paymentCount: 240 }),
    ).toBeCloseTo(585.11, 2);
  });

  it("rejects invalid inputs", () => {
    expect(calculateLoanPayment({ principal: -1, annualRate: 3, paymentCount: 12 })).toBeNull();
    expect(calculateLoanPayment({ principal: 1_000, annualRate: 3, paymentCount: 0 })).toBeNull();
  });

  it("calculates contractual end dates", () => {
    expect(format(calculateLoanEndDate(new Date(2026, 0, 31), 3)!, "yyyy-MM-dd")).toBe(
      "2026-03-31",
    );
    expect(format(calculateLoanEndDate(new Date(2025, 6, 7), 300)!, "yyyy-MM-dd")).toBe(
      "2050-06-07",
    );
  });

  it("converts a 25-year amortization to its last payment and back", () => {
    const first = new Date(2021, 6, 15);
    const monthly = calculateAmortizationSchedule(first, 300, "monthly")!;
    expect(monthly.paymentCount).toBe(300);
    expect(format(monthly.lastPaymentDate, "yyyy-MM-dd")).toBe("2046-06-15");
    expect(calculateAmortizationMonths(first, monthly.lastPaymentDate, "monthly")).toBe(300);

    const biweekly = calculateAmortizationSchedule(first, 300, "biweekly")!;
    expect(biweekly.paymentCount).toBe(650);
    expect(calculateAmortizationMonths(first, biweekly.lastPaymentDate, "biweekly")).toBe(300);
  });

  it("round-trips partial years for every cadence", () => {
    const first = new Date(2026, 0, 31);
    for (const frequency of ["monthly", "biweekly", "accelerated_biweekly"] as const) {
      for (const months of [1, 7, 271, 301]) {
        const { lastPaymentDate } = calculateAmortizationSchedule(first, months, frequency)!;
        expect(calculateAmortizationMonths(first, lastPaymentDate, frequency)).toBe(months);
      }
    }
    expect(calculateAmortizationSchedule(null, 300)).toBeNull();
    expect(calculateAmortizationSchedule(first, 0)).toBeNull();
  });

  it("supports regular and accelerated biweekly payment previews", () => {
    expect(calculatePaymentCount(25, "biweekly")).toBe(650);
    expect(
      calculateLoanPayment({
        principal: 100_000,
        annualRate: 3,
        paymentCount: 650,
        frequency: "accelerated_biweekly",
      }),
    ).toBeCloseTo(
      calculateLoanPayment({
        principal: 100_000,
        annualRate: 3,
        paymentCount: 300,
        frequency: "monthly",
      })! / 2,
      8,
    );
  });
});
