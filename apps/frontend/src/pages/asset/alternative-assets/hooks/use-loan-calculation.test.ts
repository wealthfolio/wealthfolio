import { describe, expect, it } from "vitest";
import type { Quote } from "@/lib/types";
import { LOAN_EVENTS_METADATA_KEY } from "../lib/loan-events";
import { loanRenewalEstimateRequest } from "./use-loan-calculation";

const quotes = [
  { timestamp: "2026-01-01T00:00:00Z", close: -1_000, notes: "letter" },
  { timestamp: "2026-06-01T00:00:00Z", close: -900 },
] as Quote[];
const renewal = { effectiveDate: "2026-06-01", annualRate: 4.5 };

describe("renewal estimate request", () => {
  it("adds the renewal at its date and keeps the recorded balances", () => {
    const request = loanRenewalEstimateRequest({ sub_type: "mortgage" }, quotes, renewal);
    expect(request).toMatchObject({ asOf: "2026-06-01", annualRate: 4.5 });
    expect(request.metadata).toMatchObject({ sub_type: "mortgage" });
    // Unchanged frequency and interest method are not stated on the renewal.
    expect(request.metadata[LOAN_EVENTS_METADATA_KEY]).toEqual([
      { type: "renewal", effectiveDate: "2026-06-01", annualRate: 4.5 },
    ]);
    expect(request.balances).toEqual([
      { date: "2026-01-01", balance: 1_000, notes: "letter" },
      { date: "2026-06-01", balance: 900, notes: undefined },
    ]);
  });

  it("uses a stated balance in place of that day's recorded balance", () => {
    const request = loanRenewalEstimateRequest({}, quotes, {
      ...renewal,
      frequency: "biweekly",
      interestMethod: "semiannual",
      balance: 850,
    });
    expect(request.metadata[LOAN_EVENTS_METADATA_KEY]).toEqual([
      {
        type: "renewal",
        effectiveDate: "2026-06-01",
        annualRate: 4.5,
        frequency: "biweekly",
        interestMethod: "semiannual",
      },
    ]);
    expect(request.balances).toEqual([
      { date: "2026-01-01", balance: 1_000, notes: "letter" },
      { date: "2026-06-01", balance: 850, notes: undefined },
    ]);
  });
});
