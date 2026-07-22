import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useValuationData } from "./use-valuation-data";

const mocks = vi.hoisted(() => ({
  getHistoricalValuations: vi.fn(),
}));

vi.mock("@/adapters", () => ({
  getHistoricalValuations: mocks.getHistoricalValuations,
}));

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

describe("useValuationData", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getHistoricalValuations.mockResolvedValue([
      {
        valuationDate: "2026-03-09",
        totalValueBase: 1250,
      },
    ]);
  });

  it("loads base-currency values for account scopes and ignores benchmarks", async () => {
    const { result } = renderHook(
      () =>
        useValuationData({
          selectedItems: [
            {
              id: "portfolio-1",
              type: "account",
              name: "Long term",
              accountScope: { type: "portfolio", portfolioId: "portfolio-1" },
            },
            { id: "SPY", type: "symbol", name: "S&P 500" },
          ],
          dateRange: {
            from: new Date(2026, 2, 4),
            to: new Date(2026, 2, 10),
          },
          enabled: true,
        }),
      { wrapper: createWrapper() },
    );

    await waitFor(() => {
      expect(result.current.data).toHaveLength(1);
    });

    expect(mocks.getHistoricalValuations).toHaveBeenCalledTimes(1);
    expect(mocks.getHistoricalValuations).toHaveBeenCalledWith(
      { type: "portfolio", portfolioId: "portfolio-1" },
      "2026-03-04",
      "2026-03-10",
    );
    expect(result.current.data[0]).toEqual({
      id: "portfolio-1",
      name: "Long term",
      returns: [{ date: "2026-03-09", value: 1250 }],
    });
  });

  it("does not load valuations while value mode is disabled", async () => {
    renderHook(
      () =>
        useValuationData({
          selectedItems: [
            {
              id: "portfolio:all",
              type: "account",
              name: "All Portfolio",
              accountScope: { type: "all" },
            },
          ],
          dateRange: undefined,
          enabled: false,
        }),
      { wrapper: createWrapper() },
    );

    await waitFor(() => {
      expect(mocks.getHistoricalValuations).not.toHaveBeenCalled();
    });
  });
});
