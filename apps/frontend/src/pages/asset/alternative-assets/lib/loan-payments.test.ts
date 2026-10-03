import { describe, expect, it } from "vitest";
import type { ActivityDetails } from "@/lib/types";
import { activityDay, isPaymentCandidate } from "./loan-payments";

const withdrawal = (overrides: Partial<ActivityDetails> = {}) =>
  ({
    id: "act",
    activityType: "WITHDRAWAL",
    status: "POSTED",
    date: "2026-03-01T23:30:00Z",
    currency: "CAD",
    amount: "600",
    ...overrides,
  }) as unknown as ActivityDetails;

describe("withdrawals offered as loan payments", () => {
  it("offers a posted, unlinked withdrawal in the loan's currency", () => {
    expect(isPaymentCandidate(withdrawal(), "CAD")).toBe(true);
  });

  it("skips withdrawals that are pending, in another currency or already linked", () => {
    expect(isPaymentCandidate(withdrawal({ status: "PENDING" }), "CAD")).toBe(false);
    expect(isPaymentCandidate(withdrawal({ currency: "USD" }), "CAD")).toBe(false);
    expect(
      isPaymentCandidate(withdrawal({ metadata: { loan_payment: { loan_id: "x" } } }), "CAD"),
    ).toBe(false);
  });

  it("dates a withdrawal by its UTC day, as the engine does", () => {
    expect(activityDay(withdrawal())).toBe("2026-03-01");
  });
});
