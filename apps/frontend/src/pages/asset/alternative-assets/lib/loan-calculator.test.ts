import { describe, expect, it } from "vitest";
import { format } from "date-fns";
import { parseLocalDate } from "@/lib/utils";
import {
  calculateAmortizationMonths,
  calculateLoanPaymentDate,
  countLoanPayments,
} from "./loan-calculator";

// Reading stored terms back into the form; the backend derives what is saved.
describe("stored loan calendar", () => {
  it("reads a stored 25-year horizon back as months for each cadence", () => {
    const first = parseLocalDate("2021-07-15");
    expect(calculateAmortizationMonths(first, parseLocalDate("2046-06-15"), "monthly")).toBe(300);
    const biweeklyEnd = calculateLoanPaymentDate(first, 649, "biweekly")!;
    expect(countLoanPayments(first, biweeklyEnd, "biweekly")).toBe(650);
    expect(calculateAmortizationMonths(first, biweeklyEnd, "biweekly")).toBe(300);
  });

  it("counts a stored month-end horizon as whole months and keeps a 30th payment day", () => {
    const first = parseLocalDate("2026-01-31");
    expect(calculateAmortizationMonths(first, parseLocalDate("2050-12-31"), "monthly")).toBe(300);
    expect(format(calculateLoanPaymentDate(parseLocalDate("2026-06-30"), 1)!, "yyyy-MM-dd")).toBe(
      "2026-07-30",
    );
    expect(format(calculateLoanPaymentDate(first, 2)!, "yyyy-MM-dd")).toBe("2026-03-31");
  });

  it("counts calendar days where DST starts at midnight and a date begins at 01:00", () => {
    const first = new Date(2001, 9, 14, 1);
    expect(countLoanPayments(first, new Date(2015, 8, 14), "monthly")).toBe(168);
    expect(calculateAmortizationMonths(first, new Date(2015, 8, 14), "monthly")).toBe(168);
  });
});
