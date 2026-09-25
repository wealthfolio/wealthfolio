import type { Quote } from "@/lib/types";
import type { QuoteImport } from "@/lib/types/quote-import";

export const LOAN_SCHEDULE_PROVENANCE = "loan_schedule";
export const LOAN_PAYOFF_PROVENANCE = "scheduled_payoff";
export const LOAN_EVENT_PROVENANCE = "loan_event";

export type LoanBalanceKind =
  | "confirmed_balance"
  | "projected_balance"
  | "balance_correction"
  | "extra_repayment"
  | "other";

export type LoanBalanceEntry = Pick<Quote, "close" | "notes" | "timestamp"> & {
  id?: string;
};

export type LoanBalanceImportEntry = Pick<QuoteImport, "close" | "notes" | "date">;

function hasProvenance(notes: string | null | undefined, provenance: string): boolean {
  return notes === provenance || notes?.startsWith(`${provenance}|`) === true;
}

/** Classify a balance without treating generated projections as confirmed data. */
export function classifyLoanBalance(entry: LoanBalanceEntry): LoanBalanceKind {
  if (hasProvenance(entry.notes, LOAN_SCHEDULE_PROVENANCE)) return "projected_balance";
  if (hasProvenance(entry.notes, LOAN_PAYOFF_PROVENANCE)) return "projected_balance";
  if (hasProvenance(entry.notes, `${LOAN_EVENT_PROVENANCE}|type=balance_correction`)) {
    return "balance_correction";
  }
  if (hasProvenance(entry.notes, `${LOAN_EVENT_PROVENANCE}|type=extra_repayment`)) {
    return "extra_repayment";
  }
  return "confirmed_balance";
}

export function isProjectedLoanBalance(entry: LoanBalanceEntry): boolean {
  return classifyLoanBalance(entry) === "projected_balance";
}

export function isConfirmedLoanBalance(entry: LoanBalanceEntry): boolean {
  return classifyLoanBalance(entry) !== "projected_balance";
}

export function getConfirmedLoanBalances<T extends LoanBalanceEntry>(entries: T[]): T[] {
  return entries.filter(isConfirmedLoanBalance);
}

export function getProjectedLoanBalances<T extends LoanBalanceEntry>(entries: T[]): T[] {
  return entries.filter(isProjectedLoanBalance);
}

/**
 * Compatibility view for loans created before projections were persisted as
 * metadata. Legacy future schedule rows are ignored while historical and
 * confirmed event rows remain available to the UI.
 */
export function getCurrentLoanBalances<T extends LoanBalanceEntry>(
  entries: T[],
  now = new Date(),
): T[] {
  const cutoff = now.getTime();
  const eligible = entries.filter((entry) => new Date(entry.timestamp).getTime() <= cutoff);
  const confirmedTimestamps = eligible
    .filter(isConfirmedLoanBalance)
    .map((entry) => new Date(entry.timestamp).getTime());

  if (confirmedTimestamps.length === 0) return eligible;

  const latestConfirmedTimestamp = Math.max(...confirmedTimestamps);
  return eligible.filter(
    (entry) =>
      isConfirmedLoanBalance(entry) ||
      new Date(entry.timestamp).getTime() < latestConfirmedTimestamp,
  );
}

export function getLatestCurrentLoanBalance<T extends LoanBalanceEntry>(
  entries: T[],
  now = new Date(),
): T | null {
  return (
    getCurrentLoanBalances(entries, now)
      .sort(
        (left, right) => new Date(right.timestamp).getTime() - new Date(left.timestamp).getTime(),
      )
      .at(0) ?? null
  );
}

/** Create stable provenance for a persisted dated loan event. */
export function loanEventProvenance(type: "balance_correction" | "extra_repayment"): string {
  return `${LOAN_EVENT_PROVENANCE}|type=${type}`;
}
