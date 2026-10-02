import { describe, expect, it } from "vitest";
import type { LoanCalculation, LoanCalculationRow } from "@/adapters/shared/alternative-assets";
import type { Quote } from "@/lib/types";
import { buildLoanLedger, groupLoanLedger, loanLedgerView } from "./loan-ledger";

const row = (date: string, balance: number, scheduledPayment = true): LoanCalculationRow => ({
  date,
  balance,
  openingBalance: balance + 100,
  payment: scheduledPayment ? 100 : 0,
  principal: scheduledPayment ? 80 : 0,
  interest: scheduledPayment ? 20 : 0,
  confirmed: false,
  balanceAdjustment: 0,
  extraPayment: 0,
  scheduledPayment,
});
const calculation: LoanCalculation = {
  interestMethod: "nominal_periodic",
  calculationStartDate: "2025-01-01",
  currentBalance: 600,
  annualRate: 3,
  paymentAmount: 100,
  frequency: "monthly",
  remainingPayments: 2,
  interestToDate: 0,
  projectedInterest: 0,
  residualBalance: 0,
  residualInterest: 0,
  payoffDate: "2027-01-01",
  rows: [
    row("2025-12-01", 1000),
    row("2026-01-01", 920),
    {
      ...row("2026-02-01", 700, false),
      openingBalance: 850,
      payment: 150,
      principal: 150,
      interest: 0,
      extraPayment: 150,
    },
    row("2026-03-01", 620),
    row("2026-04-01", 540),
    row("2027-01-01", 0),
  ],
};
const quote = (date: string, close: number, notes?: string) =>
  ({ id: `q-${date}`, timestamp: `${date}T00:00:00Z`, close, notes }) as Quote;
const metadata = {
  origination_date: "2025-11-01",
  original_amount: "1100",
  interest_rate: "2",
  renewal_maturity_date: "2026-09-01",
  loan_events: JSON.stringify([
    { type: "extra_repayment", effectiveDate: "2026-02-01", amount: 150 },
    { type: "renewal", effectiveDate: "2026-03-01", annualRate: 3, termEndDate: "2026-09-01" },
  ]),
};

describe("loan ledger", () => {
  const today = "2026-03-15";
  const entries = buildLoanLedger(
    calculation,
    [quote("2025-11-01", 1100), quote("2026-03-10", 610, "loan_event|type=balance_correction")],
    metadata,
    today,
  );

  it("merges start, payments, events, confirmations and the next renewal in date order", () => {
    expect(entries.map((entry) => `${entry.date}:${entry.kind}`)).toEqual([
      "2025-11-01:start",
      "2025-11-01:balance",
      "2025-12-01:payment",
      "2026-01-01:payment",
      "2026-02-01:event",
      "2026-03-01:event",
      "2026-03-01:payment",
      "2026-03-10:balance",
      "2026-04-01:payment",
      "2026-09-01:maturity",
      "2027-01-01:payment",
    ]);
    expect(entries[0]).toMatchObject({ balance: 1100, annualRate: 2 });
    expect(entries[4]).toMatchObject({ index: 0, balance: 700 });
  });

  it("filters views and groups years with totals for the shown entries", () => {
    const past = groupLoanLedger(loanLedgerView(entries, "past", today));
    expect(past.map((year) => year.year)).toEqual(["2026", "2025"]);
    expect(past[0]).toMatchObject({ paid: 200, principal: 160, interest: 40, extra: 150 });
    expect(past[0].entries[0].kind).toBe("balance");
    expect(past[0].endBalance).toBe(610);

    const upcoming = loanLedgerView(entries, "upcoming", today);
    expect(upcoming.map((entry) => entry.date)).toEqual(["2026-04-01", "2026-09-01", "2027-01-01"]);

    const events = loanLedgerView(entries, "events", today);
    expect(events.some((entry) => entry.kind === "payment")).toBe(false);
    expect(events[0].kind).toBe("maturity");
  });
});

it("keeps a same-day extra repayment out of the scheduled payment totals", () => {
  const schedule = {
    ...calculation,
    rows: [
      {
        ...row("2026-03-01", 850),
        openingBalance: 1000,
        payment: 150,
        principal: 150,
        interest: 0,
        extraPayment: 50,
      },
    ],
  };
  const entries = buildLoanLedger(
    schedule,
    [],
    {
      loan_events: [{ type: "extra_repayment", effectiveDate: "2026-03-01", amount: 50 }],
    },
    "2026-03-15",
  );
  expect(entries.find((entry) => entry.kind === "payment")).toMatchObject({
    payment: 100,
    principal: 100,
  });
  expect(groupLoanLedger(entries)[0]).toMatchObject({ paid: 100, principal: 100, extra: 50 });
});

it("uses capped applied extras in totals while preserving every recorded event for editing", () => {
  const schedule = {
    ...calculation,
    rows: [
      {
        ...row("2026-03-01", 0),
        openingBalance: 150,
        payment: 150,
        principal: 150,
        interest: 0,
        extraPayment: 50,
      },
    ],
  };
  const events = [
    { type: "extra_repayment", effectiveDate: "2026-03-01", amount: 30 },
    { type: "extra_repayment", effectiveDate: "2026-03-01", amount: 70 },
  ];
  const entries = buildLoanLedger(schedule, [], { loan_events: events }, "2026-03-15");
  expect(entries.filter((entry) => entry.kind === "event").map((entry) => entry.event)).toEqual(
    events,
  );
  expect(groupLoanLedger(entries)[0]).toMatchObject({ paid: 100, principal: 100, extra: 50 });
});

it("keeps the authoritative opening confirmation editable separately from original terms", () => {
  const opening = quote("2025-11-01", 1200);
  const entries = buildLoanLedger(
    null,
    [opening],
    { ...metadata, original_amount: "2400" },
    "2026-03-15",
  );
  expect(entries.find((entry) => entry.kind === "start")).toMatchObject({ balance: 2400 });
  expect(entries.find((entry) => entry.kind === "balance")).toMatchObject({
    balance: 1200,
    quote: opening,
  });
});
