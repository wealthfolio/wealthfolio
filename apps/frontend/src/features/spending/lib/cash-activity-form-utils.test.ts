import { AccountType } from "@/lib/constants";

import {
  cashActivityFlowMetadata,
  describeTypeChange,
  linkableTransferType,
  resolveCashActivitySubtype,
} from "./cash-activity-form-utils";

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

describe("cashActivityFlowMetadata", () => {
  it("marks CREDIT/REIMBURSEMENT as crossing the performance boundary", () => {
    expect(cashActivityFlowMetadata("CREDIT", "REIMBURSEMENT")).toEqual({
      flow: { is_external: true },
    });
  });

  it.each(["REFUND", "REBATE"])("does not infer CREDIT/%s as external", (subtype) => {
    expect(cashActivityFlowMetadata("CREDIT", subtype)).toBeUndefined();
  });

  it("does not mark unrelated cash activity types as external", () => {
    expect(cashActivityFlowMetadata("CREDIT", "BONUS")).toBeUndefined();
    expect(cashActivityFlowMetadata("WITHDRAWAL", "REFUND")).toBeUndefined();
  });

  it("preserves existing metadata when adding the reimbursement boundary marker", () => {
    expect(
      cashActivityFlowMetadata("CREDIT", "REIMBURSEMENT", {
        raw_type: "merchant_refund",
        flow: { confidence: 0.9 },
      }),
    ).toEqual({
      raw_type: "merchant_refund",
      flow: { confidence: 0.9, is_external: true },
    });
  });

  it.each([true, false])("preserves an explicit %s boundary override", (isExternal) => {
    expect(
      cashActivityFlowMetadata("CREDIT", "REFUND", {
        raw_type: "merchant_refund",
        flow: { confidence: 0.9, is_external: isExternal },
      }),
    ).toEqual({
      raw_type: "merchant_refund",
      flow: { confidence: 0.9, is_external: isExternal },
    });
  });

  it("preserves an explicit false BONUS override instead of restoring the subtype default", () => {
    expect(
      cashActivityFlowMetadata("CREDIT", "BONUS", {
        flow: { is_external: false },
      }),
    ).toEqual({
      flow: { is_external: false },
    });
  });

  it("removes only the stale boundary marker when the activity stops being a credit", () => {
    expect(
      cashActivityFlowMetadata("DEPOSIT", "BONUS", {
        raw_type: "cash_bonus",
        flow: { confidence: 0.9, is_external: true },
      }),
    ).toEqual({
      raw_type: "cash_bonus",
      flow: { confidence: 0.9 },
    });
  });

  it("returns empty metadata when the stale marker was the only value", () => {
    expect(
      cashActivityFlowMetadata("DEPOSIT", "BONUS", {
        flow: { is_external: true },
      }),
    ).toEqual({});
  });
});

describe("a saved transfer's boundary", () => {
  it("is kept while the row stays a transfer, and external when it becomes one", () => {
    const metadata = { flow: { is_external: true } };
    expect(cashActivityFlowMetadata("TRANSFER_IN", null, metadata, "TRANSFER_OUT")).toEqual(
      metadata,
    );
    expect(cashActivityFlowMetadata("TRANSFER_IN", null, undefined, "TRANSFER_IN")).toBeUndefined();
    // Its other side is not tracked until it is linked, whatever it was before.
    expect(
      cashActivityFlowMetadata("TRANSFER_IN", null, { flow: { is_external: false } }, "DEPOSIT"),
    ).toEqual({ flow: { is_external: true } });
    expect(cashActivityFlowMetadata("TRANSFER_IN", null, undefined, "WITHDRAWAL")).toEqual({
      flow: { is_external: true },
    });
  });
});

describe("describeTypeChange", () => {
  const card = AccountType.CREDIT_CARD;

  it("says a card's refund/credit becomes a payment without moving the balance", () => {
    expect(
      describeTypeChange(
        { activityType: "CREDIT", subtype: "REFUND" },
        { activityType: "TRANSFER_IN" },
        card,
      ),
    ).toEqual({ effect: "cardPayment", reversesBalance: false });
  });

  it("flags a charge becoming a payment as reversing the balance", () => {
    expect(
      describeTypeChange({ activityType: "WITHDRAWAL" }, { activityType: "TRANSFER_IN" }, card),
    ).toEqual({ effect: "cardPayment", reversesBalance: true });
  });

  it("says a bank's one-sided transfer still counts until it is linked", () => {
    expect(
      describeTypeChange(
        { activityType: "WITHDRAWAL" },
        { activityType: "TRANSFER_OUT" },
        AccountType.CASH,
      ),
    ).toEqual({ effect: "transferOut", reversesBalance: false });
  });

  it("names the report effect when a bank transfer becomes spending", () => {
    expect(
      describeTypeChange(
        { activityType: "TRANSFER_OUT" },
        { activityType: "WITHDRAWAL" },
        AccountType.CASH,
      ),
    ).toEqual({ effect: "spending", reversesBalance: false });
  });

  it("says nothing when reports and the balance are unaffected", () => {
    expect(
      describeTypeChange({ activityType: "FEE" }, { activityType: "WITHDRAWAL" }, AccountType.CASH),
    ).toBeNull();
    expect(
      describeTypeChange({ activityType: "WITHDRAWAL" }, { activityType: "WITHDRAWAL" }, card),
    ).toBeNull();
  });
});

describe("linkableTransferType", () => {
  it("makes a card's credit, but not a bank's, the card's payment", () => {
    expect(linkableTransferType("CREDIT", AccountType.CREDIT_CARD)).toBe("TRANSFER_IN");
    expect(linkableTransferType("CREDIT", AccountType.CASH)).toBeUndefined();
  });

  it("keeps a cash flow's direction", () => {
    expect(linkableTransferType("WITHDRAWAL", AccountType.CREDIT_CARD)).toBe("TRANSFER_OUT");
    expect(linkableTransferType("DEPOSIT", AccountType.CASH)).toBe("TRANSFER_IN");
    expect(linkableTransferType("FEE", AccountType.CASH)).toBeUndefined();
  });
});
