import { describe, expect, it } from "vitest";
import fixtures from "../../../../../../../crates/core/src/assets/loan/fixtures.json";
import { calculateLoanPayment, loanPeriodicRate } from "./loan-calculator";
import type { LoanPaymentFrequency } from "./loan-events";

describe("payment previews against independently captured FCAC examples", () => {
  for (const example of fixtures.fcac.cases.filter((example) => example.frequency !== "biweekly")) {
    it(example.id, () => {
      const frequency = example.frequency as LoanPaymentFrequency;
      const payment = calculateLoanPayment({
        principal: example.principal,
        annualRate: example.annualRate,
        paymentCount: example.amortizationYears * (frequency === "monthly" ? 12 : 26),
        frequency,
        interestMethod: "semiannual",
      });
      expect(payment).not.toBeNull();
      expect(Math.round(payment! * 100) / 100).toBe(example.payment);
      const firstInterest =
        example.principal * loanPeriodicRate(example.annualRate, frequency, "semiannual");
      expect(Math.round(firstInterest * 100) / 100).toBe(example.schedule[0].interest);
    });
  }

  it("preserves the legacy convention unless another method is selected", () => {
    expect(loanPeriodicRate(12, "biweekly")).toBe(0.12 / 26);
    expect(loanPeriodicRate(12, "biweekly", "semiannual")).not.toBe(0.12 / 26);
  });
});
