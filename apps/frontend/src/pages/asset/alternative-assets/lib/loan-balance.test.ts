import { describe, expect, it } from "vitest";
import { classifyLoanBalance } from "./loan-balance";

const entry = (notes?: string, timestamp = "2026-01-01T00:00:00Z", close = 100) => ({
  timestamp,
  close,
  notes,
});

describe("loan balance provenance", () => {
  it("treats every recorded balance as a confirmation", () => {
    expect(classifyLoanBalance(entry())).toBe("confirmed_balance");
    expect(classifyLoanBalance(entry("Statement"))).toBe("confirmed_balance");
  });

  it("keeps dated corrections and repayments distinguishable", () => {
    expect(classifyLoanBalance(entry("loan_event|type=balance_correction"))).toBe(
      "balance_correction",
    );
    expect(classifyLoanBalance(entry("loan_event|type=extra_repayment"))).toBe("extra_repayment");
  });
});
