import type { Quote } from "@/lib/types";

export const LOAN_EVENT_PROVENANCE = "loan_event";

export type LoanBalanceKind = "confirmed_balance" | "balance_correction" | "extra_repayment";

export type LoanBalanceEntry = Pick<Quote, "close" | "notes" | "timestamp"> & {
  id?: string;
};

function hasProvenance(notes: string | null | undefined, provenance: string): boolean {
  return notes === provenance || notes?.startsWith(`${provenance}|`) === true;
}

/** Every recorded loan balance is a confirmation; provenance only says how it was recorded. */
export function classifyLoanBalance(entry: LoanBalanceEntry): LoanBalanceKind {
  if (hasProvenance(entry.notes, `${LOAN_EVENT_PROVENANCE}|type=balance_correction`)) {
    return "balance_correction";
  }
  if (hasProvenance(entry.notes, `${LOAN_EVENT_PROVENANCE}|type=extra_repayment`)) {
    return "extra_repayment";
  }
  return "confirmed_balance";
}

/** User text follows the provenance as an escaped suffix. */
export function loanBalanceUserNote(notes: string | null | undefined): string {
  if (!notes) return "";
  if (
    notes !== "loan_closed" &&
    !notes.startsWith("loan_closed|") &&
    !notes.startsWith("loan_event|")
  )
    return notes;
  const marker = "|note=";
  const start = notes.indexOf(marker);
  if (start < 0) return "";
  try {
    return decodeURIComponent(notes.slice(start + marker.length));
  } catch {
    return notes.slice(start + marker.length);
  }
}

export function isClosedLoanBalance(entry: Pick<Quote, "close" | "notes">): boolean {
  return entry.close === 0 && hasProvenance(entry.notes, "loan_closed");
}
