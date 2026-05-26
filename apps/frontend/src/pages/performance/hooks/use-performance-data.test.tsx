import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
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
      id: "portfolio:all",
      // Return data starts on a later date than requested start to ensure
      // the hook does not mutate the query start date.
      returns: [{ date: "2026-03-09", value: "0" }],
      cumulativeTwr: "0",
      annualizedTwr: "0",
      volatility: "0",
      maxDrawdown: "0",
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
});
