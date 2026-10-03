import { describe, expect, it } from "vitest";
import type { Account, ActivityDetails } from "@/lib/types";
import { activityDay, isPaymentCandidate, paymentAccounts } from "./loan-payments";

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

it("pays a loan only from an active, unarchived cash account in its currency", () => {
  const account = (id: string, overrides: Partial<Account> = {}) =>
    ({
      id,
      accountType: "CASH",
      currency: "USD",
      isActive: true,
      isArchived: false,
      ...overrides,
    }) as Account;
  const accounts = [
    account("chequing"),
    account("savings"),
    account("card", { accountType: "CREDIT_CARD" }),
    account("brokerage", { accountType: "SECURITIES" }),
    account("cad", { currency: "CAD" }),
    account("inactive", { isActive: false }),
    account("archived", { isArchived: true }),
  ];
  expect(paymentAccounts(accounts, "USD").map((item) => item.id)).toEqual(["chequing", "savings"]);
});
