import { describe, expect, it } from "vitest";
import { changeLoanEvent, inheritedLoanSettings } from "./loan-event-editing";
import { readLoanEvents, type LoanEvent } from "./loan-events";

const extra: LoanEvent = { type: "extra_repayment", effectiveDate: "2026-03-01", amount: 100 };
const renewal: LoanEvent = {
  type: "renewal",
  effectiveDate: "2026-02-01",
  annualRate: 4,
  termEndDate: "2029-02-01",
};
describe("editing recorded loan events", () => {
  it("replaces one same-day event while preserving siblings and unrecognized entries", () => {
    const sibling = { ...extra, amount: 200 };
    const invalid = { legacy: true };
    const metadata = { loan_events: JSON.stringify([extra, invalid, sibling]), untouched: "yes" };
    const result = changeLoanEvent(metadata, 1, sibling, { ...sibling, amount: 250 });
    expect(
      readLoanEvents(result).map((event) => event.type === "extra_repayment" && event.amount),
    ).toEqual([100, 250]);
    expect(result.loan_events).toContainEqual(invalid);
    expect(result.untouched).toBe("yes");
  });
  it("refuses stale edits and invalid replacement values", () => {
    expect(() =>
      changeLoanEvent({ loan_events: [extra] }, 0, { ...extra, amount: 300 }, extra),
    ).toThrow();
    expect(() =>
      changeLoanEvent({ loan_events: [extra] }, 0, extra, { ...extra, amount: -1 }),
    ).toThrow();
  });
  it("updates linked renewal maturity and falls back when the latest renewal is deleted", () => {
    const later: LoanEvent = { ...renewal, effectiveDate: "2026-04-01", termEndDate: "2030-04-01" };
    const metadata = { loan_events: [renewal, later], renewal_maturity_date: later.termEndDate };
    const edited = changeLoanEvent(metadata, 1, later, { ...later, termEndDate: "2031-04-01" });
    expect(edited.renewal_maturity_date).toBe("2031-04-01");
    expect(changeLoanEvent(metadata, 1, later, null).renewal_maturity_date).toBe(
      renewal.termEndDate,
    );
  });
  it("preserves an independently corrected maturity when editing an older event", () => {
    expect(
      changeLoanEvent(
        { loan_events: [renewal], renewal_maturity_date: "2035-01-01" },
        0,
        renewal,
        null,
      ).renewal_maturity_date,
    ).toBe("2035-01-01");
  });
});

it("rejects edited terms the valuation engine would discard", () => {
  const metadata = { loan_events: [renewal] };
  expect(() => changeLoanEvent(metadata, 0, renewal, { ...renewal, annualRate: 101 })).toThrow(
    "Invalid loan event",
  );
  expect(() => changeLoanEvent(metadata, 0, renewal, { ...renewal, paymentAmount: 0.001 })).toThrow(
    "Invalid loan event",
  );
});

describe("inherited renewal settings", () => {
  const metadata = {
    loan_projection: {
      version: 1,
      annualRate: 4,
      paymentAmount: 500,
      frequency: "monthly",
      firstPaymentDate: "2025-02-01",
      interestMethod: "semiannual",
    },
    loan_events: [
      { type: "payment_frequency_change", effectiveDate: "2026-01-01", frequency: "biweekly" },
      { type: "renewal", effectiveDate: "2026-01-01", annualRate: 3 },
      {
        type: "renewal",
        effectiveDate: "2026-01-01",
        annualRate: 2,
        interestMethod: "monthly",
        frequency: "accelerated_biweekly",
      },
    ],
  };
  it("inherits preceding settings without using the edited or later same-day renewal", () => {
    expect(inheritedLoanSettings(metadata, 1, "2026-01-01")).toEqual({
      frequency: "biweekly",
      interestMethod: "semiannual",
    });
  });
  it("resolves inheritance again when the effective date moves", () => {
    expect(inheritedLoanSettings(metadata, 1, "2025-12-01")).toEqual({
      frequency: "monthly",
      interestMethod: "semiannual",
    });
    expect(inheritedLoanSettings(metadata, 1, "2026-02-01")).toEqual({
      frequency: "accelerated_biweekly",
      interestMethod: "monthly",
    });
  });
});

it("keeps recorded same-day ordering when an out-of-order event is moved", () => {
  const metadata = {
    loan_projection: {
      version: 1,
      annualRate: 4,
      paymentAmount: 500,
      frequency: "monthly",
      firstPaymentDate: "2025-02-01",
    },
    loan_events: [
      { type: "renewal", effectiveDate: "2026-02-01", annualRate: 3 },
      {
        type: "renewal",
        effectiveDate: "2026-01-01",
        annualRate: 2,
        interestMethod: "semiannual",
        frequency: "biweekly",
      },
    ],
  };
  // Moving the first recorded event onto January 1 still puts it before its sibling.
  expect(inheritedLoanSettings(metadata, 1, "2026-01-01")).toEqual({
    frequency: "monthly",
    interestMethod: "nominal_periodic",
  });
});

it("new backdated renewals inherit the selected date's settings, including earlier same-day events", () => {
  const metadata = {
    loan_projection: {
      version: 1,
      annualRate: 4,
      paymentAmount: 100,
      frequency: "monthly",
      firstPaymentDate: "2026-02-01",
      interestMethod: "semiannual",
    },
    loan_events: [
      {
        type: "renewal",
        effectiveDate: "2026-06-10",
        annualRate: 3,
        frequency: "biweekly",
        interestMethod: "monthly",
      },
    ],
  };
  expect(inheritedLoanSettings(metadata, -1, "2026-03-10")).toEqual({
    frequency: "monthly",
    interestMethod: "semiannual",
  });
  expect(inheritedLoanSettings(metadata, -1, "2026-06-10")).toEqual({
    frequency: "biweekly",
    interestMethod: "monthly",
  });
});

it("adds, changes and removes the latest renewal maturity even when originally absent", () => {
  const original: LoanEvent = { type: "renewal", effectiveDate: "2026-02-01", annualRate: 4 };
  const added = { ...original, termEndDate: "2029-02-01" };
  const result = changeLoanEvent({ loan_events: [original] }, 0, original, added);
  expect(result.renewal_maturity_date).toBe("2029-02-01");
  expect(changeLoanEvent(result, 0, added, original).renewal_maturity_date).toBe("");
});

it("adding maturity to an older renewal does not displace the latest term", () => {
  const old: LoanEvent = { type: "renewal", effectiveDate: "2025-02-01", annualRate: 4 };
  const result = changeLoanEvent(
    { loan_events: [old, renewal], renewal_maturity_date: renewal.termEndDate },
    0,
    old,
    { ...old, termEndDate: "2026-02-01" },
  );
  expect(result.renewal_maturity_date).toBe(renewal.termEndDate);
});
