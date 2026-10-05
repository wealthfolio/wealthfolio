import { describe, expect, it } from "vitest";
import type { AlternativeAssetHolding, LoanSummary } from "@/lib/types";
import { liabilityCardModel, liabilitySummary } from "./liability-overview-model";

const today = "2026-10-02";
const holding = (
  loan: LoanSummary | null,
  metadata: Record<string, unknown> = {},
  marketValue = "492096.97",
  valuationDate = "2026-06-07",
) =>
  ({
    id: "loan",
    kind: "liability",
    name: "Loan",
    symbol: "",
    currency: "USD",
    marketValue,
    valuationDate,
    metadata,
    loan,
  }) as AlternativeAssetHolding;

// The terms in effect today, as the backend's calculation reports them.
const mortgage: LoanSummary = {
  scheduled: true,
  originalAmount: 648668,
  annualRate: 3.94,
  paymentAmount: 1589.49,
  frequency: "biweekly",
  payoffDate: "2046-06-15",
  renewalMaturity: "2029-06-04",
};
const autoLoan: LoanSummary = {
  scheduled: false,
  originalAmount: 35000,
  annualRate: null,
  paymentAmount: null,
  frequency: null,
  payoffDate: null,
  renewalMaturity: null,
};

describe("liability card model", () => {
  it("shows the terms in effect, the payoff and the share of principal repaid", () => {
    const model = liabilityCardModel(holding(mortgage, { sub_type: "mortgage" }), today);
    expect(model).toMatchObject({
      type: "mortgage",
      scheduled: true,
      rate: 3.94,
      payment: 1589.49,
      frequency: "biweekly",
      payoffDate: "2046-06-15",
      status: null,
    });
    expect(model.paidShare).toBeCloseTo(0.2414, 4);
  });

  it("flags renewals before and after maturity", () => {
    const soon = { ...mortgage, renewalMaturity: "2026-11-15" };
    const passed = { ...mortgage, renewalMaturity: "2026-06-15" };
    expect(liabilityCardModel(holding(soon), today).status).toBe("renew_soon");
    expect(liabilityCardModel(holding(passed), today).status).toBe("renewal_due");
  });

  it("asks for a stale manual balance but never for a scheduled one", () => {
    const stale = liabilityCardModel(
      holding(autoLoan, { sub_type: "auto_loan" }, "-9096.87", "2023-01-01"),
      today,
    );
    expect(stale).toMatchObject({ scheduled: false, payment: null, status: "update_balance" });
    expect(stale.paidShare).toBeCloseTo(0.74, 2);
    expect(
      liabilityCardModel(
        holding({ ...mortgage, renewalMaturity: null }, {}, "1", "2020-01-01"),
        today,
      ).status,
    ).toBeNull();
    // A manual loan shows no payment even if one was once stored.
    expect(
      liabilityCardModel(holding({ ...autoLoan, paymentAmount: 500, frequency: "monthly" }), today),
    ).toMatchObject({ scheduled: false, payment: null, frequency: null });
  });

  it("marks a zero balance as paid off", () => {
    expect(liabilityCardModel(holding(mortgage, {}, "0"), today).status).toBe("paid_off");
  });
});

describe("liability summary", () => {
  it("adds balances, repayment and monthly payments", () => {
    const summary = liabilitySummary([
      liabilityCardModel(holding(mortgage), today),
      liabilityCardModel(holding(autoLoan, { sub_type: "auto_loan" }, "9096.87"), today),
      liabilityCardModel(holding(null, { sub_type: "other" }, "500"), today),
    ]);
    expect(summary.owed).toBeCloseTo(501693.84, 2);
    expect(summary.paidDown).toBeCloseTo(156571.03 + 25903.13, 2);
    expect(summary.overall).toBeCloseTo(182474.16 / 683668, 6);
    expect(summary.monthly).toBeCloseTo((1589.49 * 26) / 12, 6);
  });
});
