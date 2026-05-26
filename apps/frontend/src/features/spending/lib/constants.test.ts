import { AccountType } from "@/lib/constants";

import {
  getActivitySpendingAmount,
  getActivityTypesForAccount,
  isCashActivityIncome,
} from "./constants";

describe("spending constants", () => {
  describe("getActivityTypesForAccount", () => {
    it("uses card-specific activity options for credit cards", () => {
      expect(getActivityTypesForAccount(AccountType.CREDIT_CARD)).toEqual([
        "WITHDRAWAL",
        "FEE",
        "INTEREST",
        "TRANSFER_IN",
        "CREDIT",
      ]);
    });

    it("does not offer generic cash credits on cash accounts", () => {
      expect(getActivityTypesForAccount(AccountType.CASH)).not.toContain("CREDIT");
    });

    it("offers tax for cash accounts", () => {
      expect(getActivityTypesForAccount(AccountType.CASH)).toContain("TAX");
    });
  });

  describe("getActivitySpendingAmount", () => {
    it("counts credit-card charges and fees as spending", () => {
      expect(
        getActivitySpendingAmount(
          { activityType: "WITHDRAWAL", amount: "100" },
          AccountType.CREDIT_CARD,
        ),
      ).toBe(100);
      expect(
        getActivitySpendingAmount({ activityType: "FEE", amount: "25" }, AccountType.CREDIT_CARD),
      ).toBe(25);
      expect(
        getActivitySpendingAmount(
          { activityType: "INTEREST", amount: "12" },
          AccountType.CREDIT_CARD,
        ),
      ).toBe(12);
    });

    it("treats credit-card payments as non-spending and credits as refunds", () => {
      expect(
        getActivitySpendingAmount(
          { activityType: "TRANSFER_IN", amount: "100" },
          AccountType.CREDIT_CARD,
        ),
      ).toBe(0);
      expect(
        getActivitySpendingAmount(
          { activityType: "CREDIT", amount: "30" },
          AccountType.CREDIT_CARD,
        ),
      ).toBe(-30);
    });

    it("only treats cash credits as spending refunds when subtype says so", () => {
      expect(
        getActivitySpendingAmount({ activityType: "CREDIT", amount: "40" }, AccountType.CASH),
      ).toBe(0);
      expect(
        getActivitySpendingAmount(
          { activityType: "CREDIT", subtype: "REFUND", amount: "40" },
          AccountType.CASH,
        ),
      ).toBe(-40);
      expect(
        getActivitySpendingAmount(
          { activityType: "CREDIT", subtype: "BONUS", amount: "40" },
          AccountType.CASH,
        ),
      ).toBe(0);
    });

    it("counts cash tax as spending", () => {
      expect(
        getActivitySpendingAmount({ activityType: "TAX", amount: "58.22" }, AccountType.CASH),
      ).toBe(58.22);
    });

    it("ignores linked cash transfers", () => {
      expect(
        getActivitySpendingAmount(
          { activityType: "TRANSFER_OUT", amount: "100", sourceGroupId: "transfer-1" },
          AccountType.CASH,
        ),
      ).toBe(0);
    });

    it("ignores non-spending accounts", () => {
      expect(
        getActivitySpendingAmount(
          { activityType: "WITHDRAWAL", amount: "100" },
          AccountType.SECURITIES,
        ),
      ).toBe(0);
    });
  });

  describe("isCashActivityIncome", () => {
    it("uses cash credit subtypes to distinguish income from refunds", () => {
      expect(isCashActivityIncome("CREDIT", AccountType.CASH, "BONUS")).toBe(true);
      expect(isCashActivityIncome("CREDIT", AccountType.CASH, "REFUND")).toBe(false);
      expect(isCashActivityIncome("CREDIT", AccountType.CREDIT_CARD, "BONUS")).toBe(false);
    });
  });
});
