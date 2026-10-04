import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@/test/render";
import { QueryKeys } from "@/lib/query-keys";
import type { Quote } from "@/lib/types";
import { LOAN_EVENTS_METADATA_KEY } from "../lib/loan-events";
import {
  loanRenewalEstimateRequest,
  useLoanCalculation,
  useLoanToday,
} from "./use-loan-calculation";

const mocks = vi.hoisted(() => ({ calculate: vi.fn(), payments: vi.fn() }));
vi.mock("@/adapters", () => ({
  calculateLoan: mocks.calculate,
  getLoanPayments: mocks.payments,
}));
// Fourteen hours ahead of UTC: a day ahead of any browser west of UTC+9 at 15:00 UTC.
vi.mock("@/lib/settings-provider", () => ({
  useSettingsContext: () => ({ settings: { timezone: "Pacific/Kiritimati" } }),
}));

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

describe("the day a loan is valued on", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("is today in the settings timezone, as for holdings and net worth", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-01T15:00:00Z"));
    mocks.calculate.mockResolvedValue(null);
    mocks.payments.mockResolvedValue([]);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client }, children);

    expect(renderHook(() => useLoanToday()).result.current).toBe("2026-03-02");
    const metadata = {
      loan_projection: {
        version: 1,
        annualRate: 4,
        paymentAmount: 1000,
        frequency: "monthly",
        firstPaymentDate: "2026-02-01",
        amortizationEndDate: "2046-01-01",
      },
    };
    renderHook(() => useLoanCalculation("loan", metadata, quotes), { wrapper });
    await waitFor(() => expect(mocks.calculate).toHaveBeenCalled());
    expect(mocks.calculate.mock.calls[0][0]).toMatchObject({ asOf: "2026-03-02" });
  });
});

it("does not calculate without the loan's payments when reading them fails", async () => {
  mocks.calculate.mockReset().mockResolvedValue(null);
  mocks.payments.mockReset().mockRejectedValue(new Error("offline"));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
  const metadata = {
    loan_projection: {
      version: 1,
      annualRate: 4,
      paymentAmount: 1000,
      frequency: "monthly",
      firstPaymentDate: "2026-02-01",
      amortizationEndDate: "2046-01-01",
    },
  };
  renderHook(() => useLoanCalculation("loan", metadata, quotes), { wrapper });
  await waitFor(() =>
    expect(client.getQueryState([QueryKeys.ASSET_DATA, "loan", "loan-payments"])?.status).toBe(
      "error",
    ),
  );
  expect(mocks.calculate).not.toHaveBeenCalled();
});
