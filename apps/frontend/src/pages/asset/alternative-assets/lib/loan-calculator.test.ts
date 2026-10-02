import { describe, expect, it } from "vitest";
import { format } from "date-fns";
import {
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
