import { AccountType } from "@/lib/constants";

import { resolveCashActivitySubtype } from "./cash-activity-form-utils";

describe("resolveCashActivitySubtype", () => {
  it("sets reimbursement subtype for new cash-account credits", () => {
    expect(
      resolveCashActivitySubtype({
        activityType: "CREDIT",
        accountType: AccountType.CASH,
      }),
    ).toBe("REIMBURSEMENT");
  });

  it("preserves existing cash-account credit subtypes on edit", () => {
    expect(
      resolveCashActivitySubtype({
        activityType: "CREDIT",
        accountType: AccountType.CASH,
        existingActivityType: "CREDIT",
        existingSubtype: "BONUS",
      }),
    ).toBe("BONUS");
  });

  it("does not assign reimbursement subtype to credit-card credits", () => {
    expect(
      resolveCashActivitySubtype({
        activityType: "CREDIT",
        accountType: AccountType.CREDIT_CARD,
        existingActivityType: "CREDIT",
        existingSubtype: "BONUS",
      }),
    ).toBeNull();
  });
});
