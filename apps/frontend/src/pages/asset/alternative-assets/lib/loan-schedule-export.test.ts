import { describe, expect, it } from "vitest";
import type { LoanCalculation, LoanCalculationRow } from "@/adapters/shared/alternative-assets";
import { toCsv } from "@/pages/allocation-targets/components/allocation-worksheet-export";
import {
  loanScheduleExportRows,
  loanScheduleFileName,
  type LoanScheduleExportLabels,
} from "./loan-schedule-export";

const labels: LoanScheduleExportLabels = {
  title: "Loan schedule",
  date: "Date",
  status: "Status",
  statusPast: "Past",
  statusProjected: "Projected",
  confirmed: "Confirmed balance",
  scheduledPayment: "Scheduled payment",
  openingBalance: "Opening balance",
  payment: "Payment",
  principal: "Principal",
  interest: "Interest",
  extraPayment: "Extra payment",
  balanceAdjustment: "Balance adjustment",
  balance: "Closing balance",
  yes: "Yes",
  no: "No",
  loan: "Loan",
  exportedOn: "Exported on",
  currency: "Currency",
  annualRate: "Interest rate (%)",
  paymentAmount: "Regular payment",
  payoffDate: "Payoff date",
  interestToDate: "Interest to date",
  projectedInterest: "Projected interest",
  noteLabel: "Note",
  note: "Rows after the export date are projections.",
};

const row = (date: string, overrides: Partial<LoanCalculationRow> = {}): LoanCalculationRow => ({
  date,
  openingBalance: 1000,
  balance: 902.5,
  payment: 100,
  extraPayment: 0,
  scheduledPayment: true,
  principal: 97.5,
  interest: 2.5,
  confirmed: false,
  balanceAdjustment: 0,
  ...overrides,
});

const calculation: LoanCalculation = {
  currentBalance: 902.5,
  annualRate: 3.04,
  paymentAmount: 100,
  frequency: "monthly",
  interestMethod: "nominal_periodic",
  calculationStartDate: "2026-09-01",
  rows: [
    row("2026-10-01", { confirmed: true, balanceAdjustment: -0.5 }),
    row("2026-11-08", { scheduledPayment: false, payment: 0, principal: 0, interest: 0 }),
    row("2026-12-01", { extraPayment: 50, payment: 150, principal: 147.5 }),
  ],
  remainingPayments: 1,
  interestToDate: 2.5,
  projectedInterest: 2.5,
  residualBalance: 0,
  residualInterest: 0,
  payoffDate: "2027-09-01",
  allocations: [],
  instalments: [],
  paymentSuggestion: null,
};

describe("loanScheduleExportRows", () => {
  const rows = loanScheduleExportRows(
    { name: "Car loan", currency: "CAD", calculation, exportedOn: "2026-11-08" },
    labels,
  );

  it("writes every row, past through the export date and projected after it", () => {
    expect(rows[0]).toEqual([
      "Date",
      "Status",
      "Confirmed balance",
      "Scheduled payment",
      "Opening balance (CAD)",
      "Payment (CAD)",
      "Principal (CAD)",
      "Interest (CAD)",
      "Extra payment (CAD)",
      "Balance adjustment (CAD)",
      "Closing balance (CAD)",
    ]);
    expect(rows.slice(1, 4).map((cells) => cells.slice(0, 4))).toEqual([
      ["2026-10-01", "Past", "Yes", "Yes"],
      ["2026-11-08", "Past", "No", "No"],
      ["2026-12-01", "Projected", "No", "Yes"],
    ]);
  });

  it("dates the export and states the totals after the table", () => {
    const csv = toCsv(rows);
    const lines = csv.split("\n");
    expect(lines[1]).toBe(
      '"2026-10-01","Past","Yes","Yes","1000.00","100.00","97.50","2.50","0.00","-0.50","902.50"',
    );
    expect(lines[3]).toContain('"150.00","147.50","2.50","50.00"');
    expect(lines[4]).toBe("");
    expect(lines.slice(5)).toEqual([
      '"Loan schedule"',
      '"Loan","Car loan"',
      '"Exported on","2026-11-08"',
      '"Currency","CAD"',
      '"Interest rate (%)","3.04"',
      '"Regular payment (CAD)","100.00"',
      '"Payoff date","2027-09-01"',
      '"Interest to date (CAD)","2.50"',
      '"Projected interest (CAD)","2.50"',
      '"Note","Rows after the export date are projections."',
    ]);
  });

  it("writes no group separators and keeps a comma decimal mark readable", () => {
    const large = loanScheduleExportRows(
      {
        name: "Mortgage",
        currency: "EUR",
        calculation: { ...calculation, rows: [row("2026-10-01", { openingBalance: 1234567.891 })] },
        exportedOn: "2026-11-08",
      },
      labels,
    );
    expect(toCsv(large, ",").split("\n")[1]).toContain('"1234567,89";"100,00"');
  });

  it("keeps a loan name that looks like a formula as text", () => {
    const csv = toCsv(
      loanScheduleExportRows(
        { name: '=HYPERLINK("x")', currency: "USD", calculation, exportedOn: "2026-11-08" },
        labels,
      ),
    );
    expect(csv).toContain('"Loan","\'=HYPERLINK(""x"")"');
  });
});

describe("loanScheduleFileName", () => {
  it("names the loan and the export date", () => {
    expect(loanScheduleFileName("Maison — Prêt hypothécaire", "2026-11-08")).toBe(
      "loan-schedule_maison-pret-hypothecaire_2026-11-08.csv",
    );
    expect(loanScheduleFileName("주택 담보 대출", "2026-11-08")).toBe(
      "loan-schedule_주택-담보-대출_2026-11-08.csv",
    );
    expect(loanScheduleFileName("***", "2026-11-08")).toBe("loan-schedule_loan_2026-11-08.csv");
  });
});
