import { describe, expect, it } from "vitest";
import { AlternativeAssetKind } from "@/lib/types";
import {
  assetDetailsSchema,
  formValuesToMetadata,
  getDefaultDetailsFormValues,
  paymentAccountAction,
  type LiabilityDetailsFormValues,
} from "./asset-details-sheet-schema";
import { readLoanProjectionMetadata } from "../lib/loan-events";

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

  it("keeps an off-cadence stored end until the amortization is changed", () => {
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
    const values = getDefaultDetailsFormValues(AlternativeAssetKind.LIABILITY, "Mortgage", stored);
    expect(values).toMatchObject({ amortizationYears: 25, amortizationMonths: null });
    const saved = (changes: object) =>
      readLoanProjectionMetadata(formValuesToMetadata({ ...values, ...changes } as typeof values))
        ?.amortizationEndDate;
    // 2046-06-15 is not on the biweekly cadence; re-saving must not move it.
    expect(saved({})).toBe("2046-06-15");
    expect(saved({ amortizationYears: 24 })).toBe("2045-06-01");
  });

  it("saves corrected calculation inputs without replacing dated events", () => {
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
    });
    const updates = formValuesToMetadata(values);
    const merged = { ...metadata, ...updates };
    expect(readLoanProjectionMetadata(merged)).toEqual({
      version: 1,
      annualRate: 6,
      paymentAmount: 60,
      frequency: "biweekly",
      interestMethod: "semiannual",
      firstPaymentDate: "2026-01-15",
      amortizationEndDate: "2027-12-30",
    });
    expect(merged.original_amount).toBe("1500");
    expect(merged.loan_events).toBe(metadata.loan_events);
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

  it("saves and clears renewal maturity separately from amortization", () => {
    const values = assetDetailsSchema.parse({
      ...defaults(),
      renewalMaturity: new Date(2026, 5, 15),
    });
    const updates = formValuesToMetadata(values);
    expect(updates.renewal_maturity_date).toBe("2026-06-15");
    expect(readLoanProjectionMetadata(updates)?.amortizationEndDate).toBe("2027-01-28");
    expect(
      formValuesToMetadata({ ...values, renewalMaturity: null } as typeof values)
        .renewal_maturity_date,
    ).toBe("");
  });

  it("keeps manual liabilities manual and accepts their optional terms", () => {
    const values = getDefaultDetailsFormValues(AlternativeAssetKind.LIABILITY, "Manual", {
      tracking_mode: "manual",
    });
    expect(assetDetailsSchema.safeParse(values).success).toBe(true);
    expect(formValuesToMetadata(values)).not.toHaveProperty("loan_projection");
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
  expect(formValuesToMetadata(values)).toMatchObject({ tracking_mode: "manual" });

  const scheduled = formValuesToMetadata(
    assetDetailsSchema.parse({
      ...values,
      automaticLoan: true,
      interestRate: 0,
      paymentAmount: 100,
      firstPaymentDate: new Date(2026, 1, 1),
      amortizationYears: 1,
    }),
  );
  expect(scheduled.tracking_mode).toBe("");
  expect(readLoanProjectionMetadata(scheduled)).toMatchObject({
    version: 1,
    paymentAmount: 100,
    amortizationEndDate: "2027-01-01",
  });
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

  it("is saved by a loan action only when it changed, never with the metadata", () => {
    const values = { ...liability(), paymentAccountId: "chequing", escrowAmount: 100 };
    expect(paymentAccountAction(values, metadata)).toEqual({
      type: "set_payment_account",
      accountId: "chequing",
      escrowAmount: 100,
    });
    const stored = { ...metadata, payment_account_id: "chequing", escrow_amount: "100" };
    expect(paymentAccountAction(values, stored)).toBeNull();
    expect(formValuesToMetadata(values)).not.toHaveProperty("payment_account_id");
    expect(formValuesToMetadata(values)).not.toHaveProperty("escrow_amount");
  });

  it("does nothing for a manual loan", () => {
    const values = { ...liability(), automaticLoan: false, paymentAccountId: "chequing" };
    expect(paymentAccountAction(values, metadata)).toBeNull();
  });
});
