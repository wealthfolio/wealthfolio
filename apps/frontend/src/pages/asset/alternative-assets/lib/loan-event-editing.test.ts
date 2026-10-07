import { describe, expect, it } from "vitest";
import { inheritedLoanSettings } from "./loan-event-editing";

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
