import type { LoanCalculation } from "@/adapters/shared/alternative-assets";
import type { ExportCell } from "@/pages/allocation-targets/components/allocation-worksheet-export";

/** Every text the schedule export carries, already translated by the caller. */
export interface LoanScheduleExportLabels {
  title: string;
  date: string;
  status: string;
  statusPast: string;
  statusProjected: string;
  confirmed: string;
  scheduledPayment: string;
  openingBalance: string;
  payment: string;
  principal: string;
  interest: string;
  extraPayment: string;
  balanceAdjustment: string;
  balance: string;
  yes: string;
  no: string;
  loan: string;
  exportedOn: string;
  currency: string;
  annualRate: string;
  paymentAmount: string;
  payoffDate: string;
  interestToDate: string;
  projectedInterest: string;
  noteLabel: string;
  note: string;
}

export interface LoanScheduleExportInput {
  name: string;
  currency: string;
  calculation: LoanCalculation;
  /** The day the schedule was calculated as of: later rows are projections. */
  exportedOn: string;
}

const money = (value: number): ExportCell => ({ decimal: value, digits: 2 });

/**
 * Every amortisation row, past and projected, then what the schedule was
 * calculated from. The table comes first so a spreadsheet reads its header as
 * the first row; amounts are in the loan's currency.
 */
export function loanScheduleExportRows(
  { name, currency, calculation, exportedOn }: LoanScheduleExportInput,
  labels: LoanScheduleExportLabels,
): ExportCell[][] {
  const rows: ExportCell[][] = [
    [
      labels.date,
      labels.status,
      labels.confirmed,
      labels.scheduledPayment,
      `${labels.openingBalance} (${currency})`,
      `${labels.payment} (${currency})`,
      `${labels.principal} (${currency})`,
      `${labels.interest} (${currency})`,
      `${labels.extraPayment} (${currency})`,
      `${labels.balanceAdjustment} (${currency})`,
      `${labels.balance} (${currency})`,
    ],
  ];
  for (const row of calculation.rows) {
    rows.push([
      row.date,
      row.date > exportedOn ? labels.statusProjected : labels.statusPast,
      row.confirmed ? labels.yes : labels.no,
      row.scheduledPayment ? labels.yes : labels.no,
      money(row.openingBalance),
      money(row.payment),
      money(row.principal),
      money(row.interest),
      money(row.extraPayment),
      money(row.balanceAdjustment),
      money(row.balance),
    ]);
  }
  rows.push(
    [],
    [labels.title],
    [labels.loan, name],
    [labels.exportedOn, exportedOn],
    [labels.currency, currency],
    [labels.annualRate, calculation.annualRate],
    [`${labels.paymentAmount} (${currency})`, money(calculation.paymentAmount)],
    [labels.payoffDate, calculation.payoffDate ?? ""],
    [`${labels.interestToDate} (${currency})`, money(calculation.interestToDate)],
    [`${labels.projectedInterest} (${currency})`, money(calculation.projectedInterest)],
    [labels.noteLabel, labels.note],
  );
  return rows;
}

/** A name a file system takes, keeping letters of any script. */
function fileSlug(name: string, fallback: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    // Hangul syllables come apart above; put them back together.
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  return slug || fallback;
}

export function loanScheduleFileName(name: string, exportedOn: string): string {
  return `loan-schedule_${fileSlug(name, "loan")}_${exportedOn}.csv`;
}
