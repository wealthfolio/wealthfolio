import { describe, expect, it } from "vitest";
import { format } from "date-fns";
import {
  calculateLoanEndDate,
  calculateLoanPayment,
  calculatePaymentCountThroughDate,
  calculatePaymentCount,
  calculateRemainingPayments,
  projectLoan,
  projectLoanFromEvents,
  projectLoanSchedule,
} from "./loan-calculator";

describe("loan calculator", () => {
  it("calculates a fixed monthly payment", () => {
    expect(
      calculateLoanPayment({ principal: 100_000, annualRate: 3.6, paymentCount: 240 }),
    ).toBeCloseTo(585.11, 2);
  });

  it("returns the full principal and interest breakdown", () => {
    const projection = projectLoan({ principal: 1_200, annualRate: 0, paymentCount: 3 });

    expect(projection).toHaveLength(3);
    expect(projection.map((row) => row.closingBalance)).toEqual([800, 400, 0]);
    expect(projection.reduce((sum, row) => sum + row.principal, 0)).toBe(1_200);
    expect(projection.reduce((sum, row) => sum + row.interest, 0)).toBe(0);
  });

  it("uses an explicit payment while keeping the accounting invariant", () => {
    const projection = projectLoan({
      principal: 1_000,
      annualRate: 0,
      paymentCount: 3,
      paymentAmount: 400,
    });

    expect(projection.map((row) => row.closingBalance)).toEqual([600, 200, 0]);
    expect(projection.map((row) => row.payment)).toEqual([400, 400, 200]);
    expect(projection.every((row) => row.payment === row.principal + row.interest)).toBe(true);
  });

  it("does not erase an outstanding balance when the configured term is too short", () => {
    const projection = projectLoan({
      principal: 1_000,
      annualRate: 12,
      paymentCount: 2,
      paymentAmount: 100,
    });

    expect(projection).toHaveLength(2);
    expect(projection.at(-1)?.closingBalance).toBeGreaterThan(800);
    expect(projection.reduce((sum, row) => sum + row.principal, 0)).toBeLessThan(200);
  });

  it("caps the final event-driven instalment at the amount required to settle the loan", () => {
    const projection = projectLoanFromEvents({
      principal: 1_000,
      annualRate: 0,
      paymentCount: 10,
      paymentAmount: 400,
      firstPaymentDate: new Date(2026, 0, 1),
      events: [],
    });

    expect(projection.rows).toHaveLength(3);
    expect(projection.rows.map((row) => row.payment)).toEqual([400, 400, 200]);
    expect(projection.finalPayment?.closingBalance).toBe(0);
  });

  it("rejects invalid inputs", () => {
    expect(projectLoan({ principal: -1, annualRate: 3, paymentCount: 12 })).toEqual([]);
    expect(calculateLoanPayment({ principal: 1_000, annualRate: 3, paymentCount: 0 })).toBeNull();
  });

  it("calculates remaining payments and contractual end dates", () => {
    expect(calculateRemainingPayments(10_000, 0, 500)).toBe(20);
    expect(calculateRemainingPayments(100_000, 12, 500)).toBeNull();
    expect(format(calculateLoanEndDate(new Date(2026, 0, 31), 3)!, "yyyy-MM-dd")).toBe(
      "2026-03-31",
    );
    expect(format(calculateLoanEndDate(new Date(2025, 6, 7), 300)!, "yyyy-MM-dd")).toBe(
      "2050-06-07",
    );
    expect(calculatePaymentCountThroughDate(new Date(2025, 6, 7), new Date(2050, 5, 7))).toBe(300);
  });

  it("returns dated rows, the end date, and the final payment", () => {
    const projection = projectLoanSchedule({
      principal: 1_200,
      annualRate: 0,
      paymentCount: 3,
      firstPaymentDate: new Date(2026, 0, 31),
    });

    expect(projection.remainingPayments).toBe(3);
    expect(projection.rows.map((row) => format(row.paymentDate, "yyyy-MM-dd"))).toEqual([
      "2026-01-31",
      "2026-02-28",
      "2026-03-31",
    ]);
    expect(format(projection.endDate!, "yyyy-MM-dd")).toBe("2026-03-31");
    expect(projection.finalPayment?.closingBalance).toBe(0);
  });

  it("supports regular and accelerated biweekly frequencies", () => {
    expect(calculatePaymentCount(25, "monthly")).toBe(300);
    expect(calculatePaymentCount(25, "biweekly")).toBe(650);
    expect(calculatePaymentCount(25, "accelerated_biweekly")).toBe(650);

    const regular = projectLoanSchedule({
      principal: 100_000,
      annualRate: 3,
      paymentCount: 650,
      firstPaymentDate: new Date(2026, 0, 2),
      frequency: "biweekly",
    });
    const accelerated = projectLoanSchedule({
      principal: 100_000,
      annualRate: 3,
      paymentCount: 650,
      firstPaymentDate: new Date(2026, 0, 2),
      frequency: "accelerated_biweekly",
    });

    expect(accelerated.rows[0]?.payment).toBeCloseTo(
      calculateLoanPayment({
        principal: 100_000,
        annualRate: 3,
        paymentCount: 300,
        frequency: "monthly",
      })! / 2,
      2,
    );
    expect(format(regular.endDate!, "yyyy-MM-dd")).toBe("2050-11-18");
    expect(accelerated.endDate!.getTime()).toBeLessThan(regular.endDate!.getTime());
    expect(accelerated.finalPayment!.payment).toBeLessThan(accelerated.rows[0].payment);
  });

  it("uses fourteen-day intervals for biweekly payment dates", () => {
    const projection = projectLoanSchedule({
      principal: 10_000,
      annualRate: 4,
      paymentCount: 3,
      firstPaymentDate: new Date(2026, 0, 7),
      frequency: "biweekly",
    });

    expect(projection.rows.map((row) => format(row.paymentDate, "yyyy-MM-dd"))).toEqual([
      "2026-01-07",
      "2026-01-21",
      "2026-02-04",
    ]);
  });

  it("applies dated balance and rate events only to the forward projection", () => {
    const projection = projectLoanFromEvents({
      principal: 1_000,
      annualRate: 0,
      paymentCount: 4,
      paymentAmount: 250,
      firstPaymentDate: new Date(2026, 0, 1),
      events: [
        { type: "balance_correction", effectiveDate: "2026-02-01", balance: 900 },
        { type: "rate_change", effectiveDate: "2026-03-01", annualRate: 12 },
      ],
    });

    expect(projection.rows[0]).toMatchObject({ closingBalance: 750, interest: 0 });
    expect(projection.rows[1]).toMatchObject({ openingBalance: 900, closingBalance: 650 });
    expect(projection.rows[2]?.interest).toBeCloseTo(6.5, 2);
    expect(projection.rows[2]?.openingBalance).toBe(650);
  });

  it("applies an extra repayment and preserves the event order", () => {
    const projection = projectLoanFromEvents({
      principal: 1_000,
      annualRate: 0,
      paymentCount: 4,
      paymentAmount: 250,
      firstPaymentDate: new Date(2026, 0, 1),
      events: [{ type: "extra_repayment", effectiveDate: "2026-02-01", amount: 100 }],
    });

    expect(projection.rows.map((row) => row.closingBalance)).toEqual([750, 400, 150, 0]);
    expect(projection.rows[1]?.openingBalance).toBe(650);
  });

  it("uses a renewal term end date to shorten or extend only the forward projection", () => {
    const shortened = projectLoanFromEvents({
      principal: 1_000,
      annualRate: 0,
      paymentCount: 12,
      paymentAmount: 100,
      firstPaymentDate: new Date(2026, 0, 1),
      events: [
        {
          type: "renewal",
          effectiveDate: "2026-02-01",
          annualRate: 0,
          termEndDate: "2026-04-01",
        },
      ],
    });
    const extended = projectLoanFromEvents({
      principal: 1_000,
      annualRate: 0,
      paymentCount: 3,
      paymentAmount: 100,
      firstPaymentDate: new Date(2026, 0, 1),
      events: [
        {
          type: "renewal",
          effectiveDate: "2026-02-01",
          annualRate: 0,
          termEndDate: "2026-06-01",
        },
      ],
    });

    expect(shortened.rows.map((row) => format(row.paymentDate, "yyyy-MM-dd"))).toEqual([
      "2026-01-01",
      "2026-02-01",
      "2026-03-01",
      "2026-04-01",
    ]);
    expect(shortened.finalPayment?.closingBalance).toBe(600);
    expect(extended.rows.map((row) => format(row.paymentDate, "yyyy-MM-dd"))).toEqual([
      "2026-01-01",
      "2026-02-01",
      "2026-03-01",
      "2026-04-01",
      "2026-05-01",
      "2026-06-01",
    ]);
  });
});
