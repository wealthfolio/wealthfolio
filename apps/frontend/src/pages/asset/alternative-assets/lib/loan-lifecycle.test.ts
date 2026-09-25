import { describe, expect, it } from "vitest";
import type { Quote } from "@/lib/types";
import { getConfirmedLoanBalances, getProjectedLoanBalances } from "./loan-balance";
import { appendLoanEvent, type LoanMetadata } from "./loan-events";
import { projectLoanFromEvents } from "./loan-calculator";
import { buildLoanSchedule, getObsoleteFutureQuoteIds } from "./loan-schedule";
import { getLoanValuationSnapshot } from "./loan-valuation";

const baseInput = {
  principal: 250_000,
  annualRate: 3.5,
  paymentCount: 240,
  paymentAmount: 1_448.52,
  firstPaymentDate: new Date("2026-01-01T00:00:00Z"),
};

describe("loan lifecycle", () => {
  it("projects a newly created monthly loan", () => {
    const projection = projectLoanFromEvents({ ...baseInput, events: [] });
    expect(projection.rows).toHaveLength(240);
    expect(projection.rows[0]).toMatchObject({ payment: 1_448.52 });
    expect(projection.rows.at(-1)?.closingBalance).toBeLessThan(500);
  });

  it("supports monthly and biweekly payment frequencies", () => {
    const monthly = projectLoanFromEvents({ ...baseInput, events: [] });
    const biweekly = projectLoanFromEvents({
      ...baseInput,
      frequency: "biweekly",
      paymentCount: 520,
      paymentAmount: 664,
      events: [],
    });
    expect(monthly.rows[1].paymentDate.getMonth()).toBe(1);
    expect(biweekly.rows[1].paymentDate.getTime() - biweekly.rows[0].paymentDate.getTime()).toBe(
      14 * 24 * 60 * 60 * 1000,
    );
  });

  it("applies renewal and rate changes only from their effective dates", () => {
    const projection = projectLoanFromEvents({
      ...baseInput,
      events: [
        {
          type: "renewal",
          effectiveDate: "2026-04-01",
          annualRate: 4.25,
          paymentAmount: 1_500,
          termEndDate: "2046-01-01",
        },
        { type: "rate_change", effectiveDate: "2026-07-01", annualRate: 5 },
      ],
    });
    expect(projection.rows.slice(0, 3).every((row) => row.payment === 1_448.52)).toBe(true);
    expect(projection.rows[3].payment).toBe(1_500);
    expect(projection.rows[6].interest).toBeGreaterThan(projection.rows[5].interest);
  });

  it("applies balance corrections and extra repayments without rewriting history", () => {
    const projection = projectLoanFromEvents({
      ...baseInput,
      events: [
        { type: "balance_correction", effectiveDate: "2026-04-01", balance: 200_000 },
        { type: "extra_repayment", effectiveDate: "2026-07-01", amount: 10_000 },
      ],
    });
    expect(projection.rows[2].openingBalance).toBeGreaterThan(200_000);
    expect(projection.rows[3].openingBalance).toBe(200_000);
    expect(projection.rows[6].openingBalance).toBeLessThan(200_000);
  });

  it("records lifecycle events immutably, including early repayment and closure", () => {
    let metadata: LoanMetadata = {};
    metadata = appendLoanEvent(metadata, {
      type: "extra_repayment",
      effectiveDate: "2026-05-01",
      amount: 5_000,
    });
    metadata = appendLoanEvent(metadata, {
      type: "balance_correction",
      effectiveDate: "2026-06-01",
      balance: 180_000,
    });
    const closed = appendLoanEvent(metadata, {
      type: "balance_correction",
      effectiveDate: "2026-07-01",
      balance: 0,
    });
    expect(metadata.loan_events).toHaveLength(2);
    expect(closed.loan_events).toHaveLength(3);
    expect(closed.loan_events).not.toBe(metadata.loan_events);
  });

  it("keeps confirmed balances distinct from projected balances", () => {
    const quotes = [
      { timestamp: "2026-01-01T00:00:00Z", close: 250_000, notes: undefined },
      { timestamp: "2026-02-01T00:00:00Z", close: 249_200, notes: "loan_schedule|rate=3.5" },
      {
        timestamp: "2026-03-01T00:00:00Z",
        close: 248_400,
        notes: "loan_event|type=extra_repayment",
      },
    ];
    expect(getConfirmedLoanBalances(quotes)).toHaveLength(2);
    expect(getProjectedLoanBalances(quotes)).toHaveLength(1);
  });

  it("identifies obsolete legacy future schedules during migration", () => {
    const existing: Quote[] = buildLoanSchedule({
      assetId: "loan",
      currency: "EUR",
      startingBalance: 10_000,
      annualRate: 4,
      paymentCount: 12,
      firstPaymentDate: new Date("2026-01-01T00:00:00Z"),
    }).map((quote, index) => ({
      id: `quote-${index}`,
      createdAt: "2026-01-01T00:00:00Z",
      dataSource: "MANUAL",
      timestamp: `${quote.date}T00:00:00Z`,
      assetId: "loan",
      open: quote.close,
      high: quote.close,
      low: quote.close,
      volume: 0,
      close: quote.close,
      adjclose: quote.close,
      currency: quote.currency,
      notes: quote.notes,
    }));
    const obsolete = getObsoleteFutureQuoteIds(existing, new Date("2026-03-15"), []);
    expect(obsolete).toEqual(
      existing.filter((quote) => quote.timestamp.slice(0, 10) > "2026-03-15").map((q) => q.id),
    );
  });

  it("keeps valuation consistent with the latest balance used by net worth", () => {
    const snapshot = getLoanValuationSnapshot("100_000", { original_amount: "120000" }, [
      { timestamp: "2026-04-01T00:00:00Z", close: 95_000, notes: undefined } as never,
    ]);
    expect(snapshot.currentBalance).toBe(95_000);
    expect(snapshot.principalPaid).toBe(25_000);
    expect(snapshot.principalProgress).toBeCloseTo(25 / 120);
  });
});
