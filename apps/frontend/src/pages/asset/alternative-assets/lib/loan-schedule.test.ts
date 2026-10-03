import { beforeEach, expect, it, vi } from "vitest";
import { initialLoanProjection } from "./loan-schedule";
import { recalculateLoan } from "@/adapters";
import type { LoanProjectionMetadata } from "./loan-events";
vi.mock("@/adapters", () => ({ recalculateLoan: vi.fn() }));
const projection: LoanProjectionMetadata = {
  version: 1,
  annualRate: 6,
  paymentAmount: 1798.651575,
  frequency: "monthly",
  firstPaymentDate: "2026-03-01",
  paymentCount: 360,
};
beforeEach(() => vi.clearAllMocks());
it("uses the dated solver's payment, preserving the actual first payment and origination dates", async () => {
  vi.mocked(recalculateLoan).mockResolvedValue({
    paymentAmount: 1810,
    currentBalance: 300000,
    remainingPayments: 360,
  });
  const metadata = { original_amount: "300000", origination_date: "2026-01-01" };
  expect(await initialLoanProjection(metadata, projection)).toEqual({
    ...projection,
    paymentAmount: 1810,
  });
  expect(recalculateLoan).toHaveBeenCalledWith({
    metadata: { ...metadata, loan_projection: projection },
    balances: [],
    asOf: "2026-01-01",
    annualRate: 6,
  });
});
it("does not save an undated fallback when the solver is unavailable", async () => {
  vi.mocked(recalculateLoan).mockResolvedValue(null);
  await expect(initialLoanProjection({}, projection)).rejects.toThrow();
});
it("keeps accelerated payments above the dated minimum", async () => {
  vi.mocked(recalculateLoan).mockResolvedValue({
    paymentAmount: 46.16,
    currentBalance: 1200,
    remainingPayments: 26,
  });
  expect(
    (
      await initialLoanProjection(
        { origination_date: "2026-01-01" },
        {
          ...projection,
          annualRate: 0,
          paymentAmount: 50,
          frequency: "accelerated_biweekly",
          paymentCount: 26,
        },
      )
    ).paymentAmount,
  ).toBe(50);
});
