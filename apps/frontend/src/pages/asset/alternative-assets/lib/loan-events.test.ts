import { describe, expect, it } from "vitest";
import {
  LOAN_EVENTS_METADATA_KEY,
  LOAN_PROJECTION_METADATA_KEY,
  appendLoanEvent,
  isLoanEvent,
  readLoanEvents,
  readLoanProjectionMetadata,
  serializeLoanProjectionMetadata,
  type LoanMetadata,
} from "./loan-events";

describe("loan events", () => {
  it("validates supported dated event types", () => {
    expect(
      isLoanEvent({ type: "balance_correction", effectiveDate: "2026-01-15", balance: 120_000 }),
    ).toBe(true);
    expect(
      isLoanEvent({
        type: "renewal",
        effectiveDate: "2027-07-01",
        annualRate: 4.25,
        frequency: "monthly",
        termEndDate: "2032-07-01",
      }),
    ).toBe(true);
  });

  it("rejects malformed dates and invalid amounts", () => {
    expect(
      isLoanEvent({ type: "extra_repayment", effectiveDate: "2026-02-30", amount: 1_000 }),
    ).toBe(false);
    expect(
      isLoanEvent({ type: "payment_change", effectiveDate: "2026-02-01", paymentAmount: 0 }),
    ).toBe(false);
    expect(
      isLoanEvent({
        type: "payment_frequency_change",
        effectiveDate: "2026-02-01",
        frequency: "weekly",
      }),
    ).toBe(false);
  });

  it("ignores malformed persisted events and sorts valid events by effective date", () => {
    const metadata: LoanMetadata = {
      [LOAN_EVENTS_METADATA_KEY]: [
        { type: "rate_change", effectiveDate: "2027-01-01", annualRate: 4 },
        { type: "invalid", effectiveDate: "2025-01-01" },
        { type: "extra_repayment", effectiveDate: "2026-06-01", amount: 500 },
      ],
    };

    expect(readLoanEvents(metadata).map((event) => event.effectiveDate)).toEqual([
      "2026-06-01",
      "2027-01-01",
    ]);
  });

  it("reads events serialized by the metadata persistence API", () => {
    const metadata: LoanMetadata = {
      [LOAN_EVENTS_METADATA_KEY]: JSON.stringify([
        { type: "rate_change", effectiveDate: "2027-01-01", annualRate: 4 },
        { type: "extra_repayment", effectiveDate: "2026-06-01", amount: 500 },
      ]),
    };

    expect(readLoanEvents(metadata)).toEqual([
      { type: "extra_repayment", effectiveDate: "2026-06-01", amount: 500 },
      { type: "rate_change", effectiveDate: "2027-01-01", annualRate: 4 },
    ]);
    expect(readLoanEvents({ [LOAN_EVENTS_METADATA_KEY]: "not-json" })).toEqual([]);
  });

  it("appends an event immutably and preserves existing metadata", () => {
    const metadata: LoanMetadata = { interest_rate: "3.04" };
    const next = appendLoanEvent(metadata, {
      type: "extra_repayment",
      effectiveDate: "2026-05-01",
      amount: 2_000,
    });

    expect(metadata).toEqual({ interest_rate: "3.04" });
    expect(next).toMatchObject({ interest_rate: "3.04" });
    expect(next[LOAN_EVENTS_METADATA_KEY]).toEqual([
      { type: "extra_repayment", effectiveDate: "2026-05-01", amount: 2_000 },
    ]);
  });

  it("round-trips projection parameters without persisting future quotes", () => {
    const projection = {
      version: 1 as const,
      annualRate: 3.04,
      paymentAmount: 1_652.74,
      frequency: "monthly" as const,
      firstPaymentDate: "2025-07-07",
      paymentCount: 300,
      termEndDate: "2050-07-07",
    };
    const metadata: LoanMetadata = {
      [LOAN_PROJECTION_METADATA_KEY]: serializeLoanProjectionMetadata(projection),
    };

    expect(readLoanProjectionMetadata(metadata)).toEqual(projection);
    expect(readLoanProjectionMetadata({ [LOAN_PROJECTION_METADATA_KEY]: "not-json" })).toBeNull();
  });
});
