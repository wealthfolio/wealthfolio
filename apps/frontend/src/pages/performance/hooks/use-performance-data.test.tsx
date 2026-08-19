import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@/test/render";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useCalculatePerformanceHistory } from "./use-performance-data";

const mocks = vi.hoisted(() => ({
  calculatePerformanceHistory: vi.fn(),
}));

vi.mock("@/adapters", () => ({
  calculatePerformanceHistory: mocks.calculatePerformanceHistory,
}));

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

describe("useCalculatePerformanceHistory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.calculatePerformanceHistory.mockResolvedValue({
      scope: { id: "portfolio:all", currency: "USD" },
      period: { startDate: "2026-03-09", endDate: "2026-03-10" },
      mode: "timeWeighted",
      returns: {
        twr: 0,
        annualizedTwr: 0,
        irr: null,
        annualizedIrr: null,
        valueReturn: 0,
      },
      attribution: {
        contributions: 0,
        distributions: 0,
        income: 0,
        realizedPnl: 0,
        unrealizedPnlChange: 0,
        fxEffect: 0,
        fees: 0,
        taxes: 0,
        residual: 0,
      },
      risk: {
        volatility: 0,
        maxDrawdown: 0,
        peakDate: null,
        troughDate: null,
        recoveryDate: null,
        drawdownDurationDays: null,
      },
      dataQuality: {
        status: "ok",
        warnings: [],
        notApplicableReasons: [],
      },
      // Return data starts on a later date than requested start to ensure
      // the hook does not mutate the query start date.
      series: [{ date: "2026-03-09", value: 0 }],
      isHoldingsMode: false,
      isMixedTrackingMode: false,
    });
  });

  it("keeps using the user-selected start date for performance queries", async () => {
    const selectedFrom = new Date(2026, 2, 4);
    const selectedTo = new Date(2026, 2, 10);

    renderHook(
      () =>
        useCalculatePerformanceHistory({
          selectedItems: [
            {
              id: "portfolio:all",
              type: "account",
              name: "Total Portfolio",
              accountScope: { type: "all" },
            },
          ],
          dateRange: {
            from: selectedFrom,
            to: selectedTo,
          },
        }),
      { wrapper: createWrapper() },
    );

    await waitFor(() => {
      expect(mocks.calculatePerformanceHistory).toHaveBeenCalled();
    });

    const calls = mocks.calculatePerformanceHistory.mock.calls as [
      string,
      string,
      string,
      string,
    ][];
    const starts = calls.map(([, , start]) => start);
    const ends = calls.map(([, , , end]) => end);

    expect(starts.every((s) => s === "2026-03-04")).toBe(true);
    expect(ends.every((e) => e === "2026-03-10")).toBe(true);
    expect(starts.some((s) => s === "2026-03-09")).toBe(false);
  });

  it("does not invent a scoped account filter when an account item has no accountScope", async () => {
    renderHook(
      () =>
        useCalculatePerformanceHistory({
          selectedItems: [{ id: "acc-1", type: "account", name: "Brokerage" }],
          dateRange: {
            from: new Date(2026, 2, 4),
            to: new Date(2026, 2, 10),
          },
          trackingMode: "TRANSACTIONS",
        }),
      { wrapper: createWrapper() },
    );

    await waitFor(() => {
      expect(mocks.calculatePerformanceHistory).toHaveBeenCalled();
    });

    expect(mocks.calculatePerformanceHistory).toHaveBeenCalledWith(
      "account",
      "acc-1",
      "2026-03-04",
      "2026-03-10",
      "TRANSACTIONS",
      undefined,
    );
  });

  it("allows all-time performance queries without explicit dates", async () => {
    const { result } = renderHook(
      () =>
        useCalculatePerformanceHistory({
          selectedItems: [{ id: "portfolio:all", type: "account", name: "Total Portfolio" }],
          dateRange: undefined,
        }),
      { wrapper: createWrapper() },
    );

    await waitFor(() => {
      expect(mocks.calculatePerformanceHistory).toHaveBeenCalled();
    });

    expect(mocks.calculatePerformanceHistory).toHaveBeenCalledWith(
      "account",
      "portfolio:all",
      undefined,
      undefined,
      undefined,
      undefined,
    );
    expect(result.current.displayDateRange).toBe("All Time");
  });

  it("does not query when the date range is only partially populated", async () => {
    renderHook(
      () =>
        useCalculatePerformanceHistory({
          selectedItems: [{ id: "portfolio:all", type: "account", name: "Total Portfolio" }],
          dateRange: {
            from: new Date(2026, 2, 4),
            to: undefined,
          },
        }),
      { wrapper: createWrapper() },
    );

    await waitFor(() => {
      expect(mocks.calculatePerformanceHistory).not.toHaveBeenCalled();
    });
  });
});
