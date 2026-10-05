import { describe, expect, it } from "vitest";
import { AlternativeAssetKind } from "@/lib/types";
import {
  assetDetailsSchema,
  formValuesToMetadata,
  getDefaultDetailsFormValues,
  liabilityLoanSetup,
  loanSetupAction,
  type LiabilityDetailsFormValues,
} from "./asset-details-sheet-schema";

/** Fields only the backend writes, from a loan setup or a loan action. */
const LOAN_FIELDS = [
  "loan_projection",
  "loan_events",
  "renewal_maturity_date",
  "tracking_mode",
  "payment_account_id",
  "escrow_amount",
  "original_amount",
  "origination_date",
  "interest_rate",
];
const expectNoLoanFields = (metadata: Record<string, string>) => {
  for (const field of LOAN_FIELDS) expect(metadata).not.toHaveProperty(field);
};

const projection = {
  version: 1,
  annualRate: 0,
  paymentAmount: 100,
  frequency: "monthly",
  firstPaymentDate: "2026-02-28",
  paymentCount: 12,
};
const metadata = {
  original_amount: "1200",
  origination_date: "2026-01-01",
  interest_rate: "9",
  loan_projection: JSON.stringify(projection),
  loan_events: JSON.stringify([{ type: "renewal", effectiveDate: "2026-09-01", annualRate: 5 }]),
};
const defaults = () =>
  getDefaultDetailsFormValues(AlternativeAssetKind.LIABILITY, "Mortgage", metadata);

describe("correcting original loan terms", () => {
  it("loads actual base terms, including zero interest and a count-only horizon", () => {
    expect(defaults()).toMatchObject({
      interestRate: 0,
      paymentAmount: 100,
      paymentFrequency: "monthly",
      interestMethod: "nominal_periodic",
      automaticLoan: true,
      amortizationYears: 1,
      amortizationMonths: null,
    });
  });

  it("sends the stored amortization back as months, which the backend matches to its end", () => {
    const stored = {
      ...metadata,
      loan_projection: JSON.stringify({
        ...projection,
        frequency: "biweekly",
        firstPaymentDate: "2021-07-15",
        paymentCount: undefined,
        amortizationEndDate: "2046-06-15",
      }),
    };
    const values = getDefaultDetailsFormValues(
      AlternativeAssetKind.LIABILITY,
      "Mortgage",
      stored,
    ) as LiabilityDetailsFormValues;
    expect(values).toMatchObject({ amortizationYears: 25, amortizationMonths: null });
    expect(liabilityLoanSetup(values).schedule).toMatchObject({
      frequency: "biweekly",
      firstPaymentDate: "2021-07-15",
      amortizationMonths: 300,
    });
  });

  it("saves corrected terms as a loan setup, never as loan fields in the metadata", () => {
    const values = assetDetailsSchema.parse({
      ...defaults(),
      interestRate: 6,
      paymentAmount: 60,
      paymentFrequency: "biweekly",
      interestMethod: "semiannual",
      firstPaymentDate: new Date(2026, 0, 15),
      amortizationYears: 2,
      amortizationMonths: null,
      originalAmount: 1500,
    }) as LiabilityDetailsFormValues;
    expect(loanSetupAction(values)).toEqual({
      type: "set_terms",
      originalAmount: 1500,
      originationDate: "2026-01-01",
      interestRate: 6,
      schedule: {
        frequency: "biweekly",
        interestMethod: "semiannual",
        firstPaymentDate: "2026-01-15",
        amortizationMonths: 24,
        paymentAmount: 60,
        renewalMaturity: undefined,
        paymentAccountId: undefined,
        escrowAmount: undefined,
      },
    });
    expectNoLoanFields(formValuesToMetadata(values));
  });

  it("rejects missing terms and invalid payment dates", () => {
    for (const changes of [
      { interestRate: null },
      { paymentAmount: null },
      { paymentAmount: 0 },
      { firstPaymentDate: new Date(2025, 0, 1) },
      { amortizationYears: null, amortizationMonths: null },
      { amortizationYears: 0, amortizationMonths: 0 },
    ]) {
      expect(assetDetailsSchema.safeParse({ ...defaults(), ...changes }).success).toBe(false);
    }
  });

  it("sends renewal maturity with the schedule, and none once cleared", () => {
    const values = assetDetailsSchema.parse({
      ...defaults(),
      renewalMaturity: new Date(2026, 5, 15),
    }) as LiabilityDetailsFormValues;
    expect(liabilityLoanSetup(values).schedule?.renewalMaturity).toBe("2026-06-15");
    expect(
      liabilityLoanSetup({ ...values, renewalMaturity: null }).schedule?.renewalMaturity,
    ).toBeUndefined();
  });

  it("keeps manual liabilities manual and accepts their optional terms", () => {
    const values = getDefaultDetailsFormValues(AlternativeAssetKind.LIABILITY, "Manual", {
      tracking_mode: "manual",
    }) as LiabilityDetailsFormValues;
    expect(assetDetailsSchema.safeParse(values).success).toBe(true);
    expect(liabilityLoanSetup(values).schedule).toBeUndefined();
    expectNoLoanFields(formValuesToMetadata(values));
  });
});

it("rejects a first payment on the origination day", () => {
  const sameDay = {
    ...metadata,
    loan_projection: JSON.stringify({ ...projection, firstPaymentDate: "2026-01-01" }),
  };
  expect(
    assetDetailsSchema.safeParse(
      getDefaultDetailsFormValues(AlternativeAssetKind.LIABILITY, "Mortgage", sameDay),
    ).success,
  ).toBe(false);
});

it("lets a loan created before payment schedules opt into calculated payments", () => {
  // Released versions stored only these fields, sometimes under the older names.
  const released = { sub_type: "mortgage", purchase_price: "1200", purchase_date: "2026-01-01" };
  const values = getDefaultDetailsFormValues(AlternativeAssetKind.LIABILITY, "Mortgage", released);
  expect(values).toMatchObject({
    automaticLoan: false,
    originalAmount: 1200,
    paymentFrequency: "monthly",
  });
  expect(liabilityLoanSetup(values as LiabilityDetailsFormValues)).toEqual({
    originalAmount: 1200,
    originationDate: "2026-01-01",
    interestRate: undefined,
  });

  const scheduled = assetDetailsSchema.parse({
    ...values,
    automaticLoan: true,
    interestRate: 0,
    paymentAmount: 100,
    firstPaymentDate: new Date(2026, 1, 1),
    amortizationYears: 1,
  }) as LiabilityDetailsFormValues;
  expect(liabilityLoanSetup(scheduled).schedule).toMatchObject({
    paymentAmount: 100,
    firstPaymentDate: "2026-02-01",
    amortizationMonths: 12,
  });
  expectNoLoanFields(formValuesToMetadata(scheduled));
});

describe("the paid from account", () => {
  const liability = (extra: Record<string, unknown> = {}) =>
    getDefaultDetailsFormValues(AlternativeAssetKind.LIABILITY, "Mortgage", {
      ...metadata,
      ...extra,
    }) as LiabilityDetailsFormValues;

  it("loads the stored account and escrow", () => {
    expect(liability({ payment_account_id: "chequing", escrow_amount: "250" })).toMatchObject({
      paymentAccountId: "chequing",
      escrowAmount: 250,
    });
    expect(liability()).toMatchObject({ paymentAccountId: null, escrowAmount: null });
  });

  it("is saved with the loan setup, never with the metadata", () => {
    const values = { ...liability(), paymentAccountId: "chequing", escrowAmount: 100 };
    expect(liabilityLoanSetup(values).schedule).toMatchObject({
      paymentAccountId: "chequing",
      escrowAmount: 100,
    });
    expectNoLoanFields(formValuesToMetadata(values));
  });

  it("is not sent for a manual loan", () => {
    const values = { ...liability(), automaticLoan: false, paymentAccountId: "chequing" };
    expect(liabilityLoanSetup(values).schedule).toBeUndefined();
  });
});
