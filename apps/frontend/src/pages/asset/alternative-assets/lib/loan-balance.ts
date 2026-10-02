import type { Quote } from "@/lib/types";
import type { QuoteImport } from "@/lib/types/quote-import";

export const LOAN_EVENT_PROVENANCE = "loan_event";

export type LoanBalanceKind = "confirmed_balance" | "balance_correction" | "extra_repayment";

export type LoanBalanceEntry = Pick<Quote, "close" | "notes" | "timestamp"> & {
  id?: string;
};

export type LoanBalanceImportEntry = Pick<QuoteImport, "close" | "notes" | "date">;

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

/** The latest recorded balance on or before `now`. */
export function getLatestCurrentLoanBalance<T extends LoanBalanceEntry>(
  entries: T[],
  now = new Date(),
): T | null {
  const cutoff = now.getTime();
  return (
    entries
      .filter((entry) => new Date(entry.timestamp).getTime() <= cutoff)
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

export function editedLoanBalanceNotes(
  original: Pick<Quote, "close" | "notes">,
  balance: number,
  note = "",
): string | null {
  const wasClosed = hasProvenance(original.notes, "loan_closed");
  const provenance =
    wasClosed && balance === 0
      ? "loan_closed"
      : wasClosed
        ? loanEventProvenance("balance_correction")
        : original.notes?.startsWith("loan_event|")
          ? original.notes.split("|note=")[0]
          : null;
  return provenance ? provenance + (note ? `|note=${encodeURIComponent(note)}` : "") : note || null;
}
