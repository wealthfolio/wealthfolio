import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Quote } from "@/lib/types";
import { QueryKeys } from "@/lib/query-keys";

import { useQuoteMutations } from "./use-quote-mutations";

const adapterMocks = vi.hoisted(() => ({
  updateQuote: vi.fn(),
  deleteQuote: vi.fn(),
  logger: { error: vi.fn() },
}));
const performanceMocks = vi.hoisted(() => ({
  invalidatePerformanceCaches: vi.fn(),
}));

vi.mock("@/adapters", () => adapterMocks);
vi.mock("@/lib/performance-cache", () => performanceMocks);
vi.mock("@wealthfolio/ui/components/ui/use-toast", () => ({ toast: vi.fn() }));

const assetId = "asset-home-mortgage";
const quote: Quote = {
  id: `${assetId}_2026-08-17_MANUAL`,
  createdAt: "2026-08-17T00:00:00.000Z",
  dataSource: "MANUAL",
  timestamp: "2026-08-17T00:00:00Z",
  assetId,
  open: 495_000,
  high: 495_000,
  low: 495_000,
  volume: 0,
  close: 495_000,
  adjclose: 495_000,
  currency: "USD",
};

const createHarness = () => {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return { queryClient, wrapper };
};

describe("useQuoteMutations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    adapterMocks.updateQuote.mockResolvedValue(undefined);
  });

  it("defers invalidation until the batch boundary when requested", async () => {
    const { queryClient, wrapper } = createHarness();
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");
    const { result } = renderHook(
      () => useQuoteMutations(assetId, { invalidateOnSuccess: false }),
      { wrapper },
    );

    await act(async () => {
      await result.current.saveQuoteMutation.mutateAsync(quote);
    });

    expect(invalidateQueries).not.toHaveBeenCalled();
    expect(performanceMocks.invalidatePerformanceCaches).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.invalidateQuoteQueries();
    });

    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: [QueryKeys.QUOTE_HISTORY, assetId],
    });
    expect(invalidateQueries).toHaveBeenCalledTimes(3);
    expect(performanceMocks.invalidatePerformanceCaches).toHaveBeenCalledWith(queryClient);
  });
});
