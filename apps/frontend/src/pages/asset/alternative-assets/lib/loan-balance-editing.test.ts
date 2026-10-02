import { describe, expect, it } from "vitest";
import type { Quote } from "@/lib/types";
import { hasBalanceDateConflict } from "./loan-balance-editing";
import {
  editedLoanBalanceNotes,
  isClosedLoanBalance,
  loanBalanceUserNote,
  classifyLoanBalance,
} from "./loan-balance";

describe("balance editing", () => {
  const original = {
    id: "apr",
    timestamp: "2026-04-01T00:00:00Z",
    close: 500,
    notes: "loan_event|type=balance_correction",
  } as Quote;
  it("blocks occupied destination dates but allows same-date edits", () => {
    const quotes = [original, { ...original, id: "mar", timestamp: "2026-03-01T00:00:00Z" }];
    expect(hasBalanceDateConflict(quotes, original, "2026-03-01")).toBe(true);
    expect(hasBalanceDateConflict(quotes, original, "2026-04-01")).toBe(false);
    expect(hasBalanceDateConflict(quotes, original, "2026-04-02")).toBe(false);
  });
  it("round-trips user notes without losing provenance, including delimiter characters", () => {
    const note = "Statement | note=50%\nrévisé";
    const notes = editedLoanBalanceNotes(original, 450, note);
    expect(loanBalanceUserNote(notes)).toBe(note);
    expect(classifyLoanBalance({ ...original, notes })).toBe("balance_correction");
    expect(loanBalanceUserNote(editedLoanBalanceNotes({ ...original, notes }, 450, ""))).toBe("");
  });
  it("preserves closure with notes, but removes closure classification for a positive balance", () => {
    const closed = { close: 0, notes: "loan_closed" };
    const notes = editedLoanBalanceNotes(closed, 0, "Final statement");
    expect(isClosedLoanBalance({ close: 0, notes })).toBe(true);
    expect(loanBalanceUserNote(notes)).toBe("Final statement");
    expect(
      isClosedLoanBalance({ close: 50, notes: editedLoanBalanceNotes(closed, 50, "Correction") }),
    ).toBe(false);
  });
});
