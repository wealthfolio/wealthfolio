import { describe, expect, it } from "vitest";
import type { AlternativeAssetHolding } from "@/lib/types";
import { liabilityCardModel, liabilitySummary } from "./liability-overview-model";

const today = "2026-10-02";
const holding = (
  metadata: Record<string, unknown>,
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
  }) as AlternativeAssetHolding;

const mortgage = {
  sub_type: "mortgage",
  original_amount: "648668",
  renewal_maturity_date: "2029-06-04",
  loan_projection: {
    version: 1,
    annualRate: 2.09,
    paymentAmount: 1387.53,
    frequency: "biweekly",
    firstPaymentDate: "2021-07-15",
    amortizationEndDate: "2046-06-15",
  },
  loan_events: [
    { type: "renewal", effectiveDate: "2026-06-08", annualRate: 3.94, paymentAmount: 1589.49 },
    { type: "rate_change", effectiveDate: "2027-01-01", annualRate: 5 },
  ],
};

describe("liability card model", () => {
  it("uses the terms in effect today and the share of principal repaid", () => {
    expect(liabilityCardModel(holding(mortgage), today)).toMatchObject({
      type: "mortgage",
      scheduled: true,
      rate: 3.94,
      payment: 1589.49,
      frequency: "biweekly",
      status: null,
    });
    expect(liabilityCardModel(holding(mortgage), today).paidShare).toBeCloseTo(0.2414, 4);
  });

  it("flags renewals before and after maturity", () => {
    const soon = { ...mortgage, renewal_maturity_date: "2026-11-15" };
    const passed = { ...mortgage, renewal_maturity_date: "2026-06-15" };
    expect(liabilityCardModel(holding(soon), today).status).toBe("renew_soon");
    expect(liabilityCardModel(holding(passed), today).status).toBe("renewal_due");
  });

  it("asks for a stale manual balance but never for a scheduled one", () => {
    const manual = { sub_type: "auto_loan", purchase_price: "35000" };
    const stale = liabilityCardModel(holding(manual, "-9096.87", "2023-01-01"), today);
    expect(stale).toMatchObject({ scheduled: false, payment: null, status: "update_balance" });
    expect(stale.paidShare).toBeCloseTo(0.74, 2);
    expect(
      liabilityCardModel(
        holding({ ...mortgage, renewal_maturity_date: undefined }, "1", "2020-01-01"),
        today,
      ).status,
    ).toBeNull();
    expect(
      liabilityCardModel(holding({ ...mortgage, tracking_mode: "manual" }), today),
    ).toMatchObject({ scheduled: false, payment: null });
  });

  it("marks a zero balance as paid off", () => {
    expect(liabilityCardModel(holding(mortgage, "0"), today).status).toBe("paid_off");
  });
});

describe("liability summary", () => {
  it("adds balances, repayment and monthly payments", () => {
    const summary = liabilitySummary([
      liabilityCardModel(holding(mortgage), today),
      liabilityCardModel(
        holding({ sub_type: "auto_loan", purchase_price: "35000" }, "9096.87"),
        today,
      ),
      liabilityCardModel(holding({ sub_type: "other" }, "500"), today),
    ]);
    expect(summary.owed).toBeCloseTo(501693.84, 2);
    expect(summary.paidDown).toBeCloseTo(156571.03 + 25903.13, 2);
    expect(summary.overall).toBeCloseTo(182474.16 / 683668, 6);
    expect(summary.monthly).toBeCloseTo((1589.49 * 26) / 12, 6);
  });
});
