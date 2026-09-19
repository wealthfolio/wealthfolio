import { describe, expect, it } from "vitest";
import { liabilityQuickAddSchema } from "./alternative-asset-quick-add-schema";

const validLoan = {
  originalAmount: "250000",
  currentBalance: "240000",
  originationDate: new Date(2025, 0, 1),
  balanceDate: new Date(2025, 1, 1),
  loanTerm: "20",
  interestRate: "3.5",
};

describe("liability quick-add validation", () => {
  it("accepts finite positive loan data", () => {
    expect(liabilityQuickAddSchema.safeParse(validLoan).success).toBe(true);
  });

  it.each([
    { originalAmount: "-1" },
    { loanTerm: "1.5" },
    { loanTerm: "0" },
    { interestRate: "101" },
    { interestRate: "-0.1" },
  ])("rejects invalid numeric data: %o", (override) => {
    expect(liabilityQuickAddSchema.safeParse({ ...validLoan, ...override }).success).toBe(false);
  });

  it("rejects a balance date before origination", () => {
    const result = liabilityQuickAddSchema.safeParse({
      ...validLoan,
      balanceDate: new Date(2024, 11, 31),
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toBe(
        "asset:quickAdd.validation.balance_date_before_origination",
      );
    }
  });
});
