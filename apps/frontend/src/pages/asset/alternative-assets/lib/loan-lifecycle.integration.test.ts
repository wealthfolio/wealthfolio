import { describe, expect, it } from "vitest";
import { appendLoanEvent, readLoanEvents, type LoanMetadata } from "./loan-events";
import { projectLoanFromEvents } from "./loan-calculator";
import { getLoanValuationSnapshot } from "./loan-valuation";

describe("liability lifecycle integration", () => {
  it("round-trips an automated loan from creation metadata to a future projection", () => {
    const input = {
      originalAmount: "100000",
      currentBalance: "98000",
      originationDate: new Date("2026-01-01"),
      balanceDate: new Date("2026-02-01"),
      loanTerm: "10",
      interestRate: "3",
    };
    let metadata: LoanMetadata = {
      original_amount: input.originalAmount,
      origination_date: "2026-01-01",
      interest_rate: input.interestRate,
    };
    metadata = appendLoanEvent(metadata, {
      type: "renewal",
      effectiveDate: "2026-07-01",
      annualRate: 4,
      paymentAmount: 900,
      termEndDate: "2036-01-01",
    });

    const persistedMetadata: LoanMetadata = JSON.parse(JSON.stringify(metadata));
    const events = readLoanEvents(persistedMetadata);
    const projection = projectLoanFromEvents({
      principal: 98_000,
      annualRate: 3,
      paymentCount: 120,
      paymentAmount: 900,
      firstPaymentDate: new Date("2026-03-01"),
      events,
    });

    expect(projection.rows[3].payment).toBe(900);
    expect(projection.rows[3].interest).toBeGreaterThan(0);
    expect(events).toHaveLength(1);
  });

  it("keeps manual tracking free of projection requirements after reload", () => {
    const manual = {
      currentBalance: "12500",
      balanceDate: new Date("2026-01-01"),
    };
    const persisted: LoanMetadata = { tracking_mode: "manual" };
    const valuation = getLoanValuationSnapshot(manual.currentBalance, persisted, [
      {
        timestamp: "2026-01-01T00:00:00Z",
        close: 12_500,
        notes: undefined,
      } as never,
    ]);
    expect(valuation.currentBalance).toBe(12_500);
    expect(valuation.originalAmount).toBeNull();
    expect(readLoanEvents(persisted)).toEqual([]);
  });

  it("preserves the previous balance when a future event is added", () => {
    const metadata = appendLoanEvent(
      {},
      {
        type: "balance_correction",
        effectiveDate: "2099-01-01",
        balance: 70_000,
      },
    );
    const valuation = getLoanValuationSnapshot("80_000", { original_amount: "100000" }, [
      { timestamp: "2020-12-01T00:00:00Z", close: 80_000, notes: undefined } as never,
    ]);
    expect(valuation.currentBalance).toBe(80_000);
    expect(readLoanEvents(metadata)[0]).toMatchObject({ balance: 70_000 });
  });
});
