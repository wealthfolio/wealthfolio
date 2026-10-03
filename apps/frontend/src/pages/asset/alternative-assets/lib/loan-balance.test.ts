import { describe, expect, it } from "vitest";
import {
  classifyLoanBalance,
  getLatestCurrentLoanBalance,
  loanEventProvenance,
} from "./loan-balance";

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
    expect(classifyLoanBalance(entry(loanEventProvenance("balance_correction")))).toBe(
      "balance_correction",
    );
    expect(classifyLoanBalance(entry(loanEventProvenance("extra_repayment")))).toBe(
      "extra_repayment",
    );
  });

  it("ignores every future balance, including manually confirmed balances", () => {
    const entries = [
      entry(undefined, "2026-09-01T00:00:00Z", 100),
      entry(undefined, "2026-10-01T00:00:00Z", 50),
    ];

    expect(getLatestCurrentLoanBalance(entries, new Date("2026-09-15T00:00:00Z"))?.close).toBe(100);
  });

  it("returns a closed loan's zero balance as the latest confirmation", () => {
    const entries = [
      entry(undefined, "2026-02-01T00:00:00Z", 100),
      entry("loan_closed", "2026-03-01T00:00:00Z", 0),
    ];

    expect(getLatestCurrentLoanBalance(entries, new Date("2026-06-01T00:00:00Z"))?.close).toBe(0);
  });
});
